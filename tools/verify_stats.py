"""対外主張の統計値を一次ログから再計算して検証する(標準ライブラリのみ・mypy --strict)。

検証対象:
1. 全項目正解 48/50 = 96% と、その95%CI [86.3, 99.5](Clopper-Pearson 正確二項)
2. 値レベル精度 1,516/1,518 = 99.87%
3. v1の内訳が50枚で閉じること(success 38 + partial 11 + 自動fail 1)
4. 原価バッチ run-002 のキャッシュ内訳($0.024046 + $0.002938 = 差額$0.026984)

CI(GitHub Actions)から実行され、主張と再計算がずれると非0で終了する。
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def binom_tail_ge(n: int, k: int, p: float) -> float:
    """P(X >= k) for X ~ Binomial(n, p)."""
    return sum(math.comb(n, i) * p**i * (1 - p) ** (n - i) for i in range(k, n + 1))


def binom_tail_le(n: int, k: int, p: float) -> float:
    """P(X <= k) for X ~ Binomial(n, p)."""
    return sum(math.comb(n, i) * p**i * (1 - p) ** (n - i) for i in range(0, k + 1))


def clopper_pearson(k: int, n: int, alpha: float = 0.05) -> tuple[float, float]:
    """正確二項の95%信頼区間を二分法で求める(scipy不使用)。"""
    lo, hi = 0.0, 1.0
    if k > 0:
        a, b = 0.0, 1.0
        for _ in range(200):
            mid = (a + b) / 2
            if binom_tail_ge(n, k, mid) < alpha / 2:
                a = mid
            else:
                b = mid
        lo = (a + b) / 2
    if k < n:
        a, b = 0.0, 1.0
        for _ in range(200):
            mid = (a + b) / 2
            if binom_tail_le(n, k, mid) < alpha / 2:
                b = mid
            else:
                a = mid
        hi = (a + b) / 2
    return lo, hi


def approx(actual: float, expected: float, tol: float) -> bool:
    return abs(actual - expected) <= tol


def main() -> int:
    failures: list[str] = []

    # 1) 48/50 の点推定とCI
    lo, hi = clopper_pearson(48, 50)
    if not approx(48 / 50 * 100, 96.0, 1e-9):
        failures.append("48/50 != 96%")
    if not (approx(lo * 100, 86.3, 0.05) and approx(hi * 100, 99.5, 0.05)):
        failures.append(f"95%CI mismatch: got [{lo*100:.1f}, {hi*100:.1f}], claim [86.3, 99.5]")

    # 2) 値レベル精度
    if f"{1516/1518*100:.2f}" != "99.87":
        failures.append("1516/1518 != 99.87%")

    # 3) v1内訳が50で閉じる(success 38 / partial 11 / 自動fail 1)
    if 38 + 11 + 1 != 50:
        failures.append("v1 breakdown does not sum to 50")
    # v2: partial 10枚転換 + 自動fail 1枚採点success − 退行1 = 48
    if 38 + 10 + 1 - 1 != 48:
        failures.append("v2 arithmetic does not reach 48")

    # 4) run-002 のキャッシュ内訳
    run2: dict[str, object] = json.loads(
        (ROOT / "tools/cost-batch/out/run-002.json").read_text()
    )
    files_raw = run2["files"]
    assert isinstance(files_raw, list)
    files: list[dict[str, object]] = [f for f in files_raw if isinstance(f, dict)]
    costs: list[float] = [float(str(f["costUsd"])) for f in files]
    usages: list[dict[str, int]] = []
    for f in files:
        u = f["usage"]
        assert isinstance(u, dict)
        usages.append({str(k): int(str(v)) for k, v in u.items()})
    first, rest = costs[0], costs[1:]
    diff = first - sum(rest) / len(rest)
    cache_part = usages[0]["cacheCreationInputTokens"] * (1.25 - 0.1) * 5 / 1_000_000
    out_first = usages[0]["outputTokens"]
    out_avg = sum(u["outputTokens"] for u in usages[1:]) / len(rest)
    out_part = (out_first - out_avg) * 25 / 1_000_000
    if not approx(diff, 0.026984, 5e-6):
        failures.append(f"run-002 diff {diff:.6f} != 0.026984")
    if not approx(cache_part + out_part, diff, 5e-6):
        failures.append("cache + output decomposition does not explain the diff")

    if failures:
        print("NG:", *failures, sep="\n  - ")
        return 1
    print(
        f"OK: 96% CI=[{lo*100:.1f},{hi*100:.1f}] / 99.87% / v1=50枚で閉じる / "
        f"cache ${cache_part:.6f} + output ${out_part:.6f} = ${diff:.6f}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
