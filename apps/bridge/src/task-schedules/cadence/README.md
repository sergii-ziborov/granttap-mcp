# Native schedule cadence

Public entry: `validateScheduleRule` and `nextNativeOccurrence`. Accept the exact
minute/hour interval and daily/weekly wall-clock forms editable by the phone.
Compute only the next native timestamp when explicitly enabling or changing a
schedule. This module owns no timer and never executes a Task. The computer's
civil time handles daylight-saving changes; elapsed intervals remain durations.

First-party code is under the GrantTap Commercial Source License.
