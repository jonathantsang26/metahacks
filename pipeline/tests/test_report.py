"""The README's headline numbers are generated from the committed eval files and must not drift."""

from ember.config import load_fire
from tools import report


def test_readme_headline_matches_the_eval_files():
    text = report.README.read_text()
    assert report.HEADLINE_START in text and report.HEADLINE_END in text
    a = text.index(report.HEADLINE_START)
    b = text.index(report.HEADLINE_END) + len(report.HEADLINE_END)
    expected = "\n".join(report.headline([load_fire(f) for f in report.FIRES]))
    assert text[a:b] == expected, "README headline is stale: run `make report`"
    assert "n/a" not in expected, "a headline cell could not be computed from the eval files"
