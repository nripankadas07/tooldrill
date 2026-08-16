# ToolDrill conformance report

Artifact: `tooldrill.report/v1`

- Manifest: `temperature.convert`
- Cases: **23**
- Passed: **4**
- Failed: **19**

| Case | Mode | Status | Findings |
|---|---|---|---|
| `valid.baseline` | valid | pass | - |
| `invalid.from.required` | invalid | fail | stable-error |
| `invalid.label.required` | invalid | fail | stable-error |
| `invalid.temperature.required` | invalid | fail | stable-error |
| `invalid.to.required` | invalid | fail | stable-error |
| `invalid.root.additional-property` | invalid | fail | stable-error |
| `valid.from.maximum` | valid | pass | - |
| `invalid.from.type` | invalid | fail | stable-error |
| `invalid.from.enum` | invalid | fail | stable-error |
| `valid.label.maximum` | valid | pass | - |
| `invalid.label.type` | invalid | fail | stable-error |
| `invalid.label.too-short` | invalid | fail | stable-error |
| `invalid.label.too-long` | invalid | fail | stable-error |
| `invalid.label.pattern` | invalid | fail | stable-error |
| `valid.temperature.maximum` | valid | fail | response-schema, response-schema |
| `invalid.temperature.type` | invalid | fail | stable-error |
| `invalid.temperature.below-minimum` | invalid | fail | stable-error |
| `invalid.temperature.above-maximum` | invalid | fail | stable-error |
| `valid.to.maximum` | valid | pass | - |
| `invalid.to.type` | invalid | fail | stable-error |
| `invalid.to.enum` | invalid | fail | stable-error |
| `protocol.timeout` | timeout | fail | timeout |
| `protocol.cancellation` | cancellation | fail | cancellation |

> Results describe only the explicit adapter supplied to this offline harness; they are not a production security or availability proof.
