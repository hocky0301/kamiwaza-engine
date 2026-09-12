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


class TestLargeSampleSizes:
    """検証対象の n は 50 だけではない(値レベル 1,518・通算 2,225)。

    旧実装は math.comb の多倍長整数を float と掛けていたため n>=1030 で
    OverflowError になっていた。影響範囲を正確に書く——点推定(99.87%・
    0/2,225)は単純な除算なのでこの不具合の影響を受けない。壊れていたのは
    Clopper-Pearson の**区間計算**で、この n 帯で呼ぶたびに例外になっていた。
    その区間はもともと公表していない(KNOWN_ISSUES)。それでも直すのは、
    検証スクリプトが主張の n を扱えないなら「一次ログから再計算して検証する」
    という前提そのものが成立しないから。
    """

    @staticmethod
    def _naive_tail_ge(n: int, k: int, p: float) -> float:
        """旧実装(math.comb 直接)。n が小さい範囲でのみ動く参照実装。"""
        return sum(math.comb(n, i) * p**i * (1 - p) ** (n - i) for i in range(k, n + 1))

    @staticmethod
    def _naive_tail_le(n: int, k: int, p: float) -> float:
        return sum(math.comb(n, i) * p**i * (1 - p) ** (n - i) for i in range(0, k + 1))

    def test_matches_naive_where_both_run(self) -> None:
        """両方動く範囲では旧実装と一致する(書き換えで値が動いていないことの固定)。"""
        for n, k, p in ((50, 48, 0.9), (50, 10, 0.2), (200, 180, 0.85), (1029, 1000, 0.97)):
            assert binom_tail_ge(n, k, p) == pytest.approx(self._naive_tail_ge(n, k, p), rel=1e-9)
            assert binom_tail_le(n, k, p) == pytest.approx(self._naive_tail_le(n, k, p), rel=1e-9)

    def test_naive_overflows_where_this_one_does_not(self) -> None:
        """回帰の本体: 旧実装が落ちる n=1030 で、現実装は落ちない。

        破断は下側の裾 (P(X <= k)) で起きる。中央の二項係数 C(1030, 515) が
        float の上限を超え、p の値に関係なく `comb * p**i` の時点で落ちるため。
        clopper_pearson では **上限を求める分岐** がこの裾を使う。
        k == n(通算 2,225 の全数成功)はその分岐を通らないので露見しなかった。
        """
        with pytest.raises(OverflowError):
            self._naive_tail_le(1030, 1028, 0.99)
        assert 0.0 <= binom_tail_le(1030, 1028, 0.99) <= 1.0

    def test_value_level_sample_size(self) -> None:
        """値レベル n=1,518。区間は公表しないが、評価はできなければならない。"""
        lo, hi = clopper_pearson(1516, 1518)
        assert lo <= 1516 / 1518 <= hi
        assert 0.0 < lo < hi < 1.0

    def test_cumulative_sample_size(self) -> None:
        """通算 n=2,225・全数成功。k=n なので上限は 1 に張り付く。"""
        lo, hi = clopper_pearson(2225, 2225)
        assert hi == 1.0
        assert 0.0 < lo < 1.0

    def test_complementary_at_large_n(self) -> None:
        """大きい n でも P(X >= k) + P(X <= k-1) == 1 の恒等式が保たれる。"""
        for k in (1, 500, 1517, 1518):
            total = binom_tail_ge(1518, k, 0.998) + binom_tail_le(1518, k - 1, 0.998)
            assert total == pytest.approx(1.0)


class TestApprox:
    """許容誤差の判定。ここが緩むと検証全体が素通しになる。"""

    def test_within_tolerance(self) -> None:
        assert approx(1.0, 1.0005, 1e-3)

    def test_outside_tolerance(self) -> None:
        assert not approx(1.0, 1.002, 1e-3)

    def test_boundary_is_inclusive(self) -> None:
        """境界はちょうどで通す(<= であることを固定)。"""
        assert approx(1.0, 1.001, 1e-3)
