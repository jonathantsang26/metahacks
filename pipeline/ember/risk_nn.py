"""A small neighbour-attention classifier for per-cell fire risk, in plain numpy.

Each cell i has local features x_i and K neighbours j (a fixed stencil of offsets). The model
attends over the neighbours, then classifies:

    z_ij  = [x_j, g_ij]                         neighbour features + geometry (e.g. how far upwind j is)
    u_ij  = tanh(A x_i + B z_ij + c)            additive attention (Bahdanau-style)
    a_ij  = softmax_j(v · u_ij)                 over the valid neighbours of i
    ctx_i = Σ_j a_ij (V z_ij)
    p_i   = σ(w2 · relu(W1 [x_i, ctx_i] + b1) + b2)

With `attention=False` the context is dropped and it is a plain one-hidden-layer MLP on x_i.
Trained full-batch with Adam on a (soft-label) binary cross-entropy with L2. Gradients are written
out by hand; tests/test_risk_nn.py checks them against finite differences.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np


def sigmoid(x):
    return 0.5 * (1.0 + np.tanh(0.5 * x))


@dataclass
class AttentionMLP:
    d: int                  # local features per cell
    g: int                  # geometry features per neighbour edge
    attention: bool = True
    h_att: int = 16
    m_ctx: int = 16
    hidden: int = 32
    l2: float = 1e-4
    seed: int = 0
    params: dict = field(default_factory=dict)

    def __post_init__(self):
        rng = np.random.default_rng(self.seed)
        z = self.d + self.g
        init = lambda *s: rng.normal(0, 1 / np.sqrt(s[-1]), s)
        p = {"W1": init(self.hidden, self.d + (self.m_ctx if self.attention else 0)),
             "b1": np.zeros(self.hidden), "w2": init(self.hidden), "b2": np.zeros(1)}
        if self.attention:
            p |= {"A": init(self.h_att, self.d), "B": init(self.h_att, z), "c": np.zeros(self.h_att),
                  "v": init(self.h_att), "V": init(self.m_ctx, z)}
        self.params = p

    # ------------------------------------------------------------------ forward / backward

    def forward(self, x, zn=None, valid=None):
        """x (N, d); zn (N, K, d+g) neighbour inputs; valid (N, K) bool. Returns logits and a cache."""
        p, cache = self.params, {"x": x}
        h_in = x
        if self.attention:
            u = np.tanh((x @ p["A"].T)[:, None, :] + zn @ p["B"].T + p["c"])
            s = np.where(valid, u @ p["v"], -np.inf)
            s = s - s.max(axis=1, keepdims=True)
            a = np.exp(s)
            a /= a.sum(axis=1, keepdims=True)
            val = zn @ p["V"].T
            ctx = np.einsum("nk,nkm->nm", a, val)
            h_in = np.hstack([x, ctx])
            cache |= {"zn": zn, "u": u, "a": a, "val": val}
        pre = h_in @ p["W1"].T + p["b1"]
        h1 = np.maximum(pre, 0)
        logit = h1 @ p["w2"] + p["b2"][0]
        cache |= {"h_in": h_in, "pre": pre, "h1": h1}
        return logit, cache

    def loss_grad(self, x, y, w, zn=None, valid=None):
        """Weighted mean BCE (y may be soft) + L2 on weight matrices; returns (loss, grads)."""
        p = self.params
        logit, c = self.forward(x, zn, valid)
        wn = w / w.sum()
        # log(1 + e^-|l|) form is stable for large logits.
        bce = np.maximum(logit, 0) - logit * y + np.log1p(np.exp(-np.abs(logit)))
        mats = [k for k in ("W1", "w2", "A", "B", "v", "V") if k in p]  # biases are not penalised
        loss = float((wn * bce).sum() + 0.5 * self.l2 * sum((p[k] ** 2).sum() for k in mats))

        g = {}
        dlogit = wn * (sigmoid(logit) - y)
        g["w2"] = c["h1"].T @ dlogit
        g["b2"] = np.array([dlogit.sum()])
        dpre = np.outer(dlogit, p["w2"]) * (c["pre"] > 0)
        g["W1"] = dpre.T @ c["h_in"]
        g["b1"] = dpre.sum(axis=0)
        if self.attention:
            dctx = (dpre @ p["W1"])[:, self.d:]
            a, val, u, zn = c["a"], c["val"], c["u"], c["zn"]
            da = np.einsum("nm,nkm->nk", dctx, val)
            dval = a[:, :, None] * dctx[:, None, :]
            g["V"] = np.einsum("nkm,nkz->mz", dval, zn)
            ds = a * (da - (a * da).sum(axis=1, keepdims=True))
            g["v"] = np.einsum("nk,nkh->h", ds, u)
            dpre_att = ds[:, :, None] * p["v"] * (1 - u ** 2)
            g["A"] = np.einsum("nkh,nd->hd", dpre_att, c["x"])
            g["B"] = np.einsum("nkh,nkz->hz", dpre_att, zn)
            g["c"] = dpre_att.sum(axis=(0, 1))
        for k in mats:
            g[k] = g[k] + self.l2 * p[k]
        return loss, g

    # ------------------------------------------------------------------ training / inference

    def fit(self, x, y, w=None, zn=None, valid=None, epochs: int = 400, lr: float = 0.01,
            batch: int | None = 4096) -> list[float]:
        """Adam on minibatches (deterministic order from the seed). Returns the per-epoch loss."""
        rng = np.random.default_rng(self.seed + 1)
        w = np.ones(len(y)) if w is None else w
        m = {k: np.zeros_like(v) for k, v in self.params.items()}
        s = {k: np.zeros_like(v) for k, v in self.params.items()}
        b1, b2, eps, t, hist = 0.9, 0.999, 1e-8, 0, []
        n = len(y)
        bs = n if batch is None else min(batch, n)
        for _ in range(epochs):
            order = rng.permutation(n)
            total = 0.0
            for i in range(0, n, bs):
                idx = order[i:i + bs]
                loss, g = self.loss_grad(x[idx], y[idx], w[idx],
                                         None if zn is None else zn[idx], None if valid is None else valid[idx])
                total += loss * len(idx) / n
                t += 1
                for k, gk in g.items():
                    m[k] = b1 * m[k] + (1 - b1) * gk
                    s[k] = b2 * s[k] + (1 - b2) * gk ** 2
                    self.params[k] -= lr * (m[k] / (1 - b1 ** t)) / (np.sqrt(s[k] / (1 - b2 ** t)) + eps)
            hist.append(total)
        return hist

    def predict(self, x, zn=None, valid=None, chunk: int = 8192) -> np.ndarray:
        out = np.empty(len(x))
        for i in range(0, len(x), chunk):
            sl = slice(i, i + chunk)
            out[sl] = sigmoid(self.forward(x[sl], None if zn is None else zn[sl],
                                           None if valid is None else valid[sl])[0])
        return out

    def attention_weights(self, x, zn, valid, chunk: int = 8192) -> np.ndarray:
        """(N, K) attention over each cell's neighbours."""
        out = np.empty(valid.shape)
        for i in range(0, len(x), chunk):
            sl = slice(i, i + chunk)
            out[sl] = self.forward(x[sl], zn[sl], valid[sl])[1]["a"]
        return out
