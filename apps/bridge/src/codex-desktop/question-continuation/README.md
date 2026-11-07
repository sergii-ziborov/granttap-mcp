# Ownerless question continuation

`continueCodexQuestion`, exported by the parent `index.ts`, reserves the original
question's durable admission identity before a serialized CLI continuation.
Call only after native owner discovery returns definitive absence. Pending or
uncertain admissions are never retried, including from another controller.
Public delivery integration tests live in
`../../codex-questions/continuation/tests/cli-delivery.test.ts`.
