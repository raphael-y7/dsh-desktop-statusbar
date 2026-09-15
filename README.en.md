<h1 align="center">dsh-desktop-statusbar</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-desktop-statusbar"><img alt="npm version" src="https://img.shields.io/npm/v/dsh-desktop-statusbar"></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-PolyForm%20Noncommercial%201.0.0-blue"></a>
  <a href="https://github.com/raphael-y7/dsh-desktop-statusbar/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/raphael-y7/dsh-desktop-statusbar?style=social"></a>
  <img alt="dsh desktop" src="https://img.shields.io/badge/dsh%20desktop-2.0.10-blue">
  <img alt="node" src="https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-brightgreen">
  <img alt="language" src="https://img.shields.io/github/languages/top/raphael-y7/dsh-desktop-statusbar">
  <a href="https://deepseek1024.com/plugins/Rapheal-Y7/dsh-desktop-statusbar"><img alt="1024Store" src="https://img.shields.io/badge/1024Store-listed-blue"></a>
</p>

<p align="center"><a href="README.md">中文</a> | English</p>

Replaces the stats line under the composer in the DSH desktop app with a configurable status bar: pick your own fields, arrange their order, enter per-model prices, and get live cost estimates using DeepSeek's official peak/off-peak rates.

> Noncommercial license ([PolyForm Noncommercial 1.0.0](LICENSE)): free to use and modify for personal use, study, teaching and nonprofit organizations; **commercial use is not permitted**.

![Status bar](docs/statusbar.png)

## Features

- **10 optional fields**: session status (running state + peak/off-peak window), turns and steps, cache hit rate, time to first token, output speed, elapsed time, current-turn cost, session cost, balance, token count
- **Custom order**: drag the handle in the settings page to reorder; unchecking a field only hides it without changing its position; "Restore defaults" returns to the factory order with every field selected
- **Cost estimation**: priced with DeepSeek's official peak/off-peak rules — each call is calculated with the model and the moment it actually happened, then summed, so calls that cross time windows or models never get mixed up
- **Model price library**: set your own price per model, with a "peak/off-peak pricing" toggle (unchecked means one flat price all day); adding a price later retroactively recalculates earlier calls that had been skipped
- **Account balance**: reads the DeepSeek balance endpoint directly, refreshed every minute (the key stays in local memory only — never written to disk, never forwarded)
- **Bilingual UI**: follows the DSH language setting

## Installation

### Option 1: plugin marketplace / npm

Published on [npm](https://www.npmjs.com/package/dsh-desktop-statusbar) and listed in [DSH 1024Store](https://deepseek1024.com/plugins/Rapheal-Y7/dsh-desktop-statusbar) (category: UI Enhancements):

```powershell
dsh plugin --profile desktop add dsh-desktop-statusbar
```

Replace `desktop` with your own profile name. You can also install straight from the GitHub source (identical content):

```powershell
dsh plugin --profile desktop add github:raphael-y7/dsh-desktop-statusbar
```

### Option 2: manual installation

1. Clone the project into the DSH local plugin directory:

   ```powershell
   git clone https://github.com/raphael-y7/dsh-desktop-statusbar "$env:USERPROFILE\.dsh\local-plugins\dsh-desktop-statusbar"
   ```

2. Install the single dependency (`zod`):

   ```powershell
   cd "$env:USERPROFILE\.dsh\local-plugins\dsh-desktop-statusbar"
   npm install --omit=dev
   ```

3. Register it with DSH's own command line (it adds the dependency declaration and the link for you):

   ```powershell
   dsh plugin --profile desktop add "$env:USERPROFILE\.dsh\local-plugins\dsh-desktop-statusbar"
   ```

4. Restart DSH and refresh the page.

## Usage

Open **Settings → Status bar**:

![Settings page](docs/settings.png)

- **Basics**: enable the status bar, allow wrapping
- **Data fields**: check the fields you want, drag the six-dot handle on the right to reorder
- **Custom model prices**: enter the prices for the models you use (per million tokens, in CNY). Click "Edit" to expand, then "Save" to commit; a new model defaults to a flat all-day price — enable "peak/off-peak pricing" when you need the split

### Billing rules

Peak hours are **Beijing time, Monday to Friday, 09:00–12:00 and 14:00–18:00**; everything else is off-peak and costs half the peak rate — consistent with DeepSeek's official documentation ([Models & Pricing](https://api-docs.deepseek.com/zh-cn/quick_start/pricing), checked 2026-09-15).

Public holidays and make-up workdays are **not handled separately**: the official rule only looks at the day of the week, so a holiday falling on a weekday is still billed as peak/off-peak, and a make-up workday falling on a weekend is still billed at the off-peak rate.

![Custom model prices](docs/pricing.png)

### Things to know

Models **without a price in the library are skipped and not billed** (not a miscalculation — the price is simply unknown). Once you add the price, every earlier call of that model is recalculated into the total. The status bar fields update immediately; there is no need to reopen the session.

## Known limitations

- The model name shown by "current session usage" is reported by the status bar to the plugin backend and then read by the settings page — the DSH settings page is a global slot and cannot read session projections, so this detour is unavoidable
- Hiding the official stats line relies on the DSH slot contract (`conversation.composer.dock`) rather than the official component's class names, so DSH rebuilding its assets will not break it; if DSH changes the slot itself, this plugin has to follow
- The session projection keeps only the latest 4000 calls; older ones no longer take part in cost recalculation

## Development

```
tests/    16 test scripts (plain Node, no browser needed)
tools/    test.cjs runs them all; sync-from-plugin.cjs copies the plugin directory sources into the project
```

```powershell
node tools/test.cjs
```

Coverage: field placeholders and formatting, peak/off-peak boundaries across weekends and weekdays, price self-healing and recalculation, storage-key migration, metric hover, host routes, navigation icon replacement, dead-code scan.

## License

This project uses the [PolyForm Noncommercial 1.0.0](LICENSE): **permitted** for personal use, research, study, teaching and hobby projects, as well as charitable, educational, public research, public safety/health, environmental and government use; **permitted** to modify and redistribute (with the license and attribution preserved); **commercial use is not permitted**.

This is not an OSI-approved open source license — the source is public, but commercial use requires separate permission.

## Acknowledgements

The idea comes from the DSH community project [`@bananiceee/dsh-status-bar`](https://www.npmjs.com/package/@bananiceee/dsh-status-bar) (MIT): hide the official stats line and take over with a self-built bar.

This project is an **independent implementation**. Line-by-line comparison against version 0.1.10 of that project: of 1415 non-empty lines, 247 are textually identical (17.5%), and 190 of those are short lines such as `}` and `);`; **only 9 identical lines are longer than 40 characters**, all of them required DSH platform integration boilerplate (`ctx.slots.inject(...)`, `useProjection("tokenUsage")`, module wrapper scaffolding) and generic function names (`apply`, `formatTokens`, `segmentView`). Beyond those there is no shared code.
