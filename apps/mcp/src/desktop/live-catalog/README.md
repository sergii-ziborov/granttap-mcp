# Desktop live catalog

`desktopLiveCatalog` projects current native provider observations through the
exact persisted local Project, Task, provider, session and computer links.
It is served by the existing private desktop socket and parsing worker.
It does not rewrite Execution closure, Task ownership or handoff history.
Completed Tasks and former owners cannot become current through this read.
The result is bounded to 40 sessions; tests live beside this entry point.

Licensed under the MIT License; see the repository LICENSE.
