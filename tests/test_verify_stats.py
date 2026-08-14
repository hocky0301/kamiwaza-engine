"""verify_stats.py の統計計算に対する回帰テスト。

対外主張「全項目正解 48/50 = 96%、95%CI [86.3, 99.5]」を支えているのは
clopper_pearson の二分法実装であって、外部ライブラリではない(scipy 不使用)。
つまり **この実装が壊れると、主張の根拠ごと壊れる**。

そこで、既知の値・数学的な恒等式・境界条件でその性質を固定する。
「検証スクリプトそのものを検証する」ためのファイル。
"""

from __future__ import annotations

import math

import pytest

from verify_stats import approx, binom_tail_ge, binom_tail_le, clopper_pearson


class TestBinomTails:
    """二項分布の裾確率。恒等式で固定する(期待値をベタ書きしない)。"""

    def test_ge_zero_is_certain(self) -> None:
        """P(X >= 0) は常に 1。"""
        assert binom_tail_ge(50, 0, 0.3) == pytest.approx(1.0)

    def test_le_n_is_certain(self) -> None:
        """P(X <= n) は常に 1。"""
        assert binom_tail_le(50, 50, 0.3) == pytest.approx(1.0)

    def test_complementary(self) -> None:
        """P(X >= k) + P(X <= k-1) == 1 が全ての k で成り立つ。"""
        for k in range(1, 51):
            total = binom_tail_ge(50, k, 0.4) + binom_tail_le(50, k - 1, 0.4)
            assert total == pytest.approx(1.0)

    def test_symmetry_at_half(self) -> None:
        """p=0.5 では P(X >= k) == P(X <= n-k)(分布が対称)。"""
        for k in range(21):
            assert binom_tail_ge(20, k, 0.5) == pytest.approx(binom_tail_le(20, 20 - k, 0.5))

    def test_known_value(self) -> None:
        """n=1, k=1, p=0.5 → 0.5(手で確かめられる最小ケース)。"""
        assert binom_tail_ge(1, 1, 0.5) == pytest.approx(0.5)

    def test_monotone_in_p(self) -> None:
        """P(X >= k) は p について単調増加。二分法が成立する前提そのもの。"""
        prev = -1.0
        for p in (0.1, 0.3, 0.5, 0.7, 0.9):
            cur = binom_tail_ge(50, 40, p)
            assert cur > prev
            prev = cur


class TestClopperPearson:
    """正確二項の信頼区間。主張の数字を直接支えている部分。"""

    def test_contains_point_estimate(self) -> None:
        """区間は必ず点推定を含む。"""
        lo, hi = clopper_pearson(48, 50)
        assert lo <= 48 / 50 <= hi

    def test_public_claim(self) -> None:
        """README・記事に出している [86.3, 99.5] を固定する。"""
        lo, hi = clopper_pearson(48, 50)
        assert round(lo * 100, 1) == 86.3
        assert round(hi * 100, 1) == 99.5

    def test_zero_successes_lower_bound_is_zero(self) -> None:
        """k=0 では下限が 0 に落ちる(片側区間になる境界)。"""
        lo, hi = clopper_pearson(0, 50)
        assert lo == 0.0
        assert 0.0 < hi < 1.0

    def test_all_successes_upper_bound_is_one(self) -> None:
        """k=n では上限が 1 に張り付く(もう片方の境界)。"""
        lo, hi = clopper_pearson(50, 50)
        assert hi == 1.0
        assert 0.0 < lo < 1.0

    def test_wald_overshoots_but_exact_does_not(self) -> None:
        """小標本・高比率では Wald 近似が定義域(<=1)を出る。正確法を選んだ理由。"""
        k, n = 48, 50
        p = k / n
        se = math.sqrt(p * (1 - p) / n)
        assert p + 1.96 * se > 1.0  # 正規近似は 1 を超えて壊れる
        _, hi = clopper_pearson(k, n)
        assert hi <= 1.0  # 正確法は出ない

    def test_narrows_with_n(self) -> None:
        """同じ比率なら n が大きいほど区間は狭くなる。"""
        small_lo, small_hi = clopper_pearson(24, 25)
        large_lo, large_hi = clopper_pearson(48, 50)
        assert (large_hi - large_lo) < (small_hi - small_lo)


class TestApprox:
    """許容誤差の判定。ここが緩むと検証全体が素通しになる。"""

    def test_within_tolerance(self) -> None:
        assert approx(1.0, 1.0005, 1e-3)

    def test_outside_tolerance(self) -> None:
        assert not approx(1.0, 1.002, 1e-3)

    def test_boundary_is_inclusive(self) -> None:
        """境界はちょうどで通す(<= であることを固定)。"""
        assert approx(1.0, 1.001, 1e-3)
