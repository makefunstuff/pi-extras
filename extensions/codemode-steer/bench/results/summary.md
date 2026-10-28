# codemode-steer eval

## Codemode

3 tickets (`bulk-rename`, `cli-json`, `config-rename`), DeepSeek Flash. Hidden `node:test` graders; the same eval in every arm. `off` and `codemode-steer` (`enforce`) ran 2 rounds (6 runs each); the `nudge` diagnostic ran 1 round (3 runs).

Share is codemode calls / (codemode + direct calls). Steer blocks are direct calls codemode-steer stopped.

| arm | runs | codemode calls | direct calls | codemode share | codemode turns | codemode errors | steer blocks |
|---|---|---|---|---|---|---|---|
| codemode-steer | 6 | 13 | 28 | 31.7% | 13 | 1 | 4 |
| nudge | 3 | 1 | 23 | 4.2% | 1 | 0 | 0 |
| off | 6 | 0 | 88 | 0.0% | 0 | 0 | 0 |
## Runs

- `codemode-steer`: 6/6 passed, 6 run(s)
- `nudge`: 3/3 passed, 3 run(s)
- `off`: 6/6 passed, 6 run(s)

| arm | pass | wall s med | wall s mean | turns | calls | call err | in | out | ctx peak |
|---|---|---|---|---|---|---|---|---|---|
| codemode-steer | 6/6 | 26.4 | 25.8 | 7.2 | 6.8 | 1.2 | 9,282 | 3,568 | 16,312 |
| nudge | 3/3 | 25.1 | 23.5 | 6.7 | 8.0 | 0.0 | 7,161 | 2,981 | 14,862 |
| off | 6/6 | 28.3 | 40.7 | 12.2 | 14.7 | 1.0 | 10,206 | 4,754 | 18,954 |
