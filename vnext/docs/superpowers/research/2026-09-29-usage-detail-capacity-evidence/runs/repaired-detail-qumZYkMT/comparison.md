| Runtime | Profile | View | Original SQL | Repaired SQL | Original bytes | Repaired bytes | Original ms | Repaired ms |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| sqlite | realistic | admin-today | 39 | 11 | 23750 | 23750 | 8.77 | 12.21 |
| sqlite | realistic | admin-28d | 50 | 17 | 1536438 | 1536438 | 49.31 | 30.68 |
| sqlite | realistic | viewer-today | 44 | 14 | 15537 | 15537 | 12.10 | 6.76 |
| sqlite | realistic | viewer-28d | 59 | 22 | 1225057 | 1225057 | 31.65 | 30.36 |
| sqlite | high | admin-today | 2224 | 11 | 518849 | 518849 | 26.15 | 20.56 |
| sqlite | high | admin-28d | 2632 | 17 | 53060504 | 53060504 | 1234.52 | 986.42 |
| sqlite | high | viewer-today | 3818 | 14 | 387576 | 387576 | 36.20 | 48.94 |
| sqlite | high | viewer-28d | 4826 | 22 | 43032207 | 43032207 | 962.82 | 1222.72 |
| workerd | realistic | admin-today | 39 | 11 | 23750 | 23750 | 16.70 | 29.98 |
| workerd | realistic | admin-28d | 50 | 17 | 1536438 | 1536438 | 102.50 | 73.00 |
| workerd | realistic | viewer-today | 44 | 14 | 15537 | 15537 | 17.92 | 11.22 |
| workerd | realistic | viewer-28d | 59 | 22 | 1225057 | 1225057 | 78.33 | 69.18 |
| workerd | high | admin-today | 2224 | 11 | 518849 | 518849 | 427.35 | 51.33 |
| workerd | high | admin-28d | 2632 | 17 | 53060504 | 53060504 | 3294.99 | 2654.81 |
| workerd | high | viewer-today | FAILED | 14 | FAILED | 387576 | FAILED | 70.85 |
| workerd | high | viewer-28d | FAILED | 22 | FAILED | 43032207 | FAILED | 2700.00 |
