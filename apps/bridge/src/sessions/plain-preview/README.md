# Plain catalog previews

`plainPreview` turns a complete visible assistant message into a bounded catalog
summary. Markdown is tokenized before the display limit is applied, so a long
link destination or emphasis span cannot leave a broken delimiter in a task
card. Blocks retain word boundaries; code punctuation stays literal. No HTML is
rendered, links followed, or original transcript text rewritten.

The Codex and Claude scanners use this entry point for summaries. Shared title
projection also parses before its existing display limit. Full transcript
messages retain their original Markdown. Tests cover scanner output and the
plain-text projection independently.

Licensed under the GrantTap Commercial Source License. See LICENSE and NOTICE.
