# Creative Manifest Prompt

This prompt defines the structured text contract for a single `creative` slide.

## Purpose

Generate one short, hook-first salon creative that reads instantly on a phone screen.

## Input

Use only:
- `title`
- `brief`
- `tags`

## Output Contract

Return JSON only.

Required shape:
- `eyebrow`: usually `""`
- `headline`: one strong hook
- `subhead`: one short line that lands the joke or insight
- `bullets`: `[]` by default, maximum 2 short bullets when they truly help
- `footer`: optional short clarification

Exact runtime shape:

```json
{
  "eyebrow": "",
  "headline": "...",
  "subhead": "...",
  "bullets": ["..."],
  "footer": ""
}
```

## Writing Rules

- Start with the hook, not with explanation.
- Keep `headline` short, punchy, and readable in one glance.
- Keep `subhead` short and human; it should not restate the headline.
- Do not write service phrases like "ироничный креатив про..." or "шутка про...".
- Use salon-coded humor:
  - client phrases
  - salon timing
  - tools or products as characters
  - daily salon life
  - common home-care mistakes
  - light self-irony of the master
- Avoid mean sarcasm, shaming, and long setup.
- Avoid dense copy and complex storytelling.
- Use simple everyday wording instead of hard jargon.

## Runtime Mapping

Use this document for:
- `creative_manifest_generation`
