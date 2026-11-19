---
name: breatic-document
description: Use when reading or editing a breatic document Space — changing words in a block, inserting or deleting blocks, commenting on text, or putting pictures and videos into a document.
---

# Working on a breatic document

## Reading

`read_document` gives each top-level block with:

| Field | What it is |
|---|---|
| `id`, `type` | The block |
| `markdown` | The block as Markdown, children included |
| `text` | Its plain text: what `edit_document_text` matches against |
| `notInMarkdown` | What the block carries that Markdown cannot: text colour, background colour, underline, alignment, comments |

A block marked `unsupported` is of a kind this service does not know: leave it as it is. The read also gives the comment threads (the words each is on, who wrote what, which agent wrote a reply) and the people in the document with the block their caret is in and the words they selected.

## Changing words

Use `edit_document_text` for any change inside a block: `find` is a passage of the block's plain text and `replace` the words to put there. The new words keep every mark the old passage had (comments, colours, links, bold); the rest of the block is untouched. Quote a longer passage when the words appear more than once in the block (`ambiguous_text`); a passage cannot span two lines of the block.

A block whose `notInMarkdown` is not empty must be changed this way: rewriting it from Markdown drops what Markdown cannot carry.

## Adding and removing blocks

- `insert_document_blocks` inserts Markdown as new blocks after `afterBlockId`, or at the end. Headings go to level 3 at most.
- To restyle a block, insert its new version and delete the old one with `delete_document_blocks`; that drops the old block's comments and colours.
- `delete_document_blocks` deletes blocks with their children. If any block named is not in the document, none is deleted.

## Media

An image in inserted Markdown that is already in our storage stays as it is; an `http(s)` image from elsewhere is fetched into our storage and lands as a normal image; one that cannot be fetched is left out and counted in `mediaLeftOut`.

For a file on your machine (or one you processed), upload it with `begin_upload` destination `document` and `afterBlockId`: the media block is inserted once the file is stored (`breatic-media-files`).

## Comments

`comment_on_document` starts a thread on a block (on the words `find` names, or the block's whole text) or replies to a thread (`threadId`). Replying to a thread handed to you answers it.
