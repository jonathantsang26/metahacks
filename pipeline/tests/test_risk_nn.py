"""The hand-written gradients of the risk model's attention MLP match finite differences."""

import numpy as np
import pytest

from ember.risk_nn import AttentionMLP


def _problem(seed=0, n=40, k=5, d=4, g=2):
    rng = np.random.default_rng(seed)
    x = rng.normal(size=(n, d))
    zn = rng.normal(size=(n, k, d + g))
    valid = rng.random((n, k)) > 0.2
    valid[:, 0] = True
    y = rng.random(n)            # soft labels
    w = rng.random(n) + 0.5
    return x, zn, valid, y, w


@pytest.mark.parametrize("attention", [True, False])
def test_gradients_match_finite_differences(attention):
    x, zn, valid, y, w = _problem()
    model = AttentionMLP(d=4, g=2, attention=attention, h_att=3, m_ctx=3, hidden=5, l2=1e-2, seed=3)
    args = (x, y, w, zn if attention else None, valid if attention else None)
    _, grads = model.loss_grad(*args)
    eps = 1e-6
    for name, param in model.params.items():
        flat = param.reshape(-1)
        for i in range(0, flat.size, max(1, flat.size // 7)):
            old = flat[i]
            flat[i] = old + eps
            up, _ = model.loss_grad(*args)
            flat[i] = old - eps
            down, _ = model.loss_grad(*args)
            flat[i] = old
            num = (up - down) / (2 * eps)
            assert abs(num - grads[name].reshape(-1)[i]) < 1e-5 * max(1.0, abs(num)), name


def test_attention_ignores_invalid_neighbours_and_learns_a_neighbour_rule():
    rng = np.random.default_rng(1)
    n, k = 3000, 4
    x = rng.normal(size=(n, 2))
    zn = rng.normal(size=(n, k, 3))
    zn[:, :, 2] = 0.0
    zn[:, 1, 2] = 1.0            # geometry flag marks the informative neighbour
    valid = np.ones((n, k), bool)
    valid[:, 3] = False
    zn[:, 3, :2] = 50.0          # garbage behind the mask must not leak in
    y = (zn[:, 1, 0] > 0).astype(float)  # label depends only on neighbour 1
    model = AttentionMLP(d=2, g=1, attention=True, seed=0)
    model.fit(x, y, zn=zn, valid=valid, epochs=60, lr=0.01, batch=512)
    a = model.attention_weights(x, zn, valid)
    assert np.allclose(a[:, 3], 0)
    assert a[:, 1].mean() > 0.5
    acc = ((model.predict(x, zn, valid) > 0.5) == y).mean()
    assert acc > 0.9
