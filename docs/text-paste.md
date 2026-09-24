# Large text pastes

Varro turns plain-text pastes of at least 2,000 characters or 25 lines into inline
text chips. Open the chip menu and choose **Expand to text** to edit the full paste.
Copied editor selections, terminal selections,
context references, and mixed image/PDF pastes keep their existing handling.

Text attachments preserve the clipboard text in the draft and queue snapshot.
They use a `text/plain` data attachment when sent, so they do not depend on a
temporary file surviving a reload. Click the chip to inspect its text in an editor.
Removing, undoing, and redoing an attachment uses the normal composer history.
Converting a paste replaces that paste's history entry with the attachment.

Each text attachment is limited to 64 KB of UTF-8 text, with 256 KB per composer
draft. Larger pastes stay inline with a visible explanation. Editing the draft or
switching sessions before source matching finishes cancels the pending conversion.
