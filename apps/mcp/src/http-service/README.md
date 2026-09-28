# HTTP service

This module installs and verifies the optional macOS LaunchAgent that keeps Cursor's loopback OAuth MCP endpoint available. The installer validates every executable and restores the exact prior owned plist after a failed repair.

The request service uses the Interactive launchd process class because the Mac
app depends on its HTTP and desktop socket responses. These channels do not use
XPC transactions, so Adaptive cannot promote their transcript-reading children.
The separate unattended session monitor remains Background.

License: this module is distributed under the MIT License in the repository-root `LICENSE` file.
