# Simulated Limbo — distribution test (100,000 rounds, crypto RNG)

Run: 2026-11-19T13:46:02.703Z. Settings: config/limbo-sim.json. ENTERTAINMENT ONLY — not Housebets odds/RTP.

| Tier | Observed vs configured |
|---|---|
| small_win | 37.86% (configured 38.00%) |
| medium_win | 22.01% (configured 22.00%) |
| large_win | 8.99% (configured 9.00%) |
| huge_win | 2.05% (configured 2.00%) |
| loss | 29.09% (configured 29.00%) |

- Chi-square (tiers): 2.34 (critical value at p=0.001: 18.47) → matches configuration
- Overall win rate: 70.91 %
- Winning results at least double the target: 50.2 % (Limbo-shaped tail, expected ≈ 50 %)
- Results ≥ 100x: 3732 of 100,000
- RNG: 10-bin chi-square 1.39 (crit 27.88) · lag-1 correlation -0.0013 · win/loss runs test z = 1.89 (|z| < 3.3)
- Every round: outcome = (result ≥ target); payout = bet × target on a win, 0 on a loss; no repeating sequence; two engines never share a sequence.
