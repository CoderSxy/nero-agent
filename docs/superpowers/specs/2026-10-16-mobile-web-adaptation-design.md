# Mobile web adaptation

## Intent

At widths up to 767px, give Nero Agent the same mobile information architecture and visual language as the reference Datax web app: an Inbox, a recent conversation list, dedicated conversation, file, and model pages, and a compact composer. Keep the existing desktop application and its data contracts.

## Navigation

`/agent/new` is the mobile Inbox. `/agent/:threadId` is the conversation page. `/history`, `/files`, and `/models` are mobile pages; on desktop they redirect to existing appropriate views. The mobile shell supplies profile and back controls. The Inbox presents a two-column grid with conversation, file, model, and disabled placeholder cards; below it are recent normal or scheduled threads and a scheduled-task entry.

## Data and behavior

Use `useThreadList`, existing thread source filtering and history search, `AgentChat`, `WorkspaceFileTree`, and the model catalog client. The Inbox and chat use a capsule composer with direct text input; its plus button opens file, image, workspace file, model, and finance choices. Selecting a file from the Inbox creates a thread and carries the file into chat. Sending from the Inbox creates a thread and submits its draft once. Conversation actions expose rename and delete. File management uses the personal workspace file API and preview overlay. The model list shows only supported catalog fields; no synthetic quota or speed. The fourth card says 敬请期待 and is disabled. Preserve loading, empty, and error states.

## Layout

Use the reference's 767px breakpoint, warm canvas, rounded cards, 44px touch targets, safe-area padding, and full-height page scroll regions. Mobile chat has a fixed top navigation bar and bottom composer, with the message viewport as the scroll region. Desktop styles are unaffected by mobile selectors.

## Verification

Test navigation, card data, source switching, file and model lists, and composer behavior. Run the web test and build scripts, then inspect mobile widths in a browser if available.
