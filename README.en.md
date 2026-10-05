<h1 align="center">dsh-desktop-statusbar</h1>

<p align="center">
  <a href="https://github.com/raphael-y7/dsh-desktop-statusbar/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/raphael-y7/dsh-desktop-statusbar?style=social"></a>
  <a href="https://github.com/deepseek-ai/deepseek-harness"><img alt="DeepSeek Harness" src="https://img.shields.io/badge/DeepSeek%20Harness-0.2.0--rc.2-%234d6bfe"></a>
  <a href="https://dshfind.com/zh/plugins/raphael-y7/dsh-desktop-statusbar"><img alt="dshfind" src="https://img.shields.io/badge/dshfind-listed-%2300a884"></a>
  <a href="https://deepseek1024.com/plugins/Rapheal-Y7/dsh-desktop-statusbar"><img alt="1024Store" src="https://img.shields.io/badge/1024Store-listed-orange"></a>
  <a href="https://www.npmjs.com/package/dsh-desktop-statusbar"><img alt="npm version" src="https://img.shields.io/npm/v/dsh-desktop-statusbar?color=red"></a>
  <a href="https://nodejs.org/"><img alt="node" src="https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-%235fa04e"></a>
  <img alt="language" src="https://img.shields.io/github/languages/top/raphael-y7/dsh-desktop-statusbar?color=yellow">
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-green"></a>
</p>

<p align="center"><a href="README.md">中文</a> | English</p>

Replaces the stats line under the message input in the DSH desktop app with a configurable status bar: fields, ordering, per-model prices and currency are all configurable, with live cost estimates using DeepSeek's official peak/off-peak rates.

![Status bar](docs/statusbar.en.png)

## Features

- **10 optional fields**: context occupancy (the ring at the head of the bar), peak / off-peak check, turns and steps, combined hit, TPS, TTFT, run time, this turn cost, session cost, balance
- **Click a field for details**:

  | Field | Content |
  | --- | --- |
  | Context ring (bar head) | System prompt / tool definitions / messages |
  | Peak / off-peak check | Usage heat map: day / week / month / year |
  | Turns and steps | Context compactions / skills injected / tool calls |
  | Combined hit | This turn / highest / lowest cache hit rate |
  | TPS | This turn / fastest / slowest speed |
  | TTFT | This turn / fastest / slowest first-token delay |
  | Run time | Wait time / model time / tool calls |
  | This turn cost | Token breakdown for this turn |
  | Session cost | Cumulative token breakdown for the whole session |
  | Balance | Top-up balance / granted balance / quota left |

- **Drill down from "turns and steps"**: three rows — context compactions (each with the turn and step it happened at), skills injected (including the global `AGENTS.md` prompt, listed first), and tool calls (every tool used, by count). Click a row to go deeper, click the title to go back
- **Version check and one-click update**: the plugin compares against the latest npm version on startup, shows a badge next to the "Status bar" nav item when one is available, and the settings page grows an "Update" button that installs it
- **Activity overview**: hover the peak / off-peak field for that day's usage, click for the whole month as a heat map, with week and whole-year views. The data comes from a local usage ledger, so **deleting a session's logs never loses it**
- **Cost estimation**: priced with the official peak/off-peak rules; each call is computed from the moment it happened and the model it used
- **Price book**: your own prices, an optional peak/off-peak split, and a CNY / USD currency switch
- **Also**: one-click holiday calendar update, balance refreshed every minute, bilingual UI

## Install

In the DSH desktop app, open **Plugins → Add plugin** and install by package name:

```
dsh-desktop-statusbar
```

Where the npm registry is not reachable, the same dialog offers the China mainland mirror as the install source. A GitHub repository URL is also accepted:

```
https://github.com/raphael-y7/dsh-desktop-statusbar
```

Command line:

```powershell
dsh plugin --profile desktop add dsh-desktop-statusbar
```

### Install from npm

Both ways above install from the npm registry; the package name is `dsh-desktop-statusbar`. To check the current version on npm:

```powershell
npm view dsh-desktop-statusbar version
```

Also listed on [dshfind](https://dshfind.com/zh/plugins/raphael-y7/dsh-desktop-statusbar) and [1024Store](https://deepseek1024.com/plugins/Rapheal-Y7/dsh-desktop-statusbar).

## Usage

Open **Settings → Status bar**:

![Settings page](docs/settings.en.png)

- **Session status**: the ring at the front of the bar — progress shows context occupancy and colour the run state (grey idle / green running / red error / amber pending approval); click it for the token composition
- **Stats fields**: ticking controls visibility only, so unticking hides a field without moving it; drag the handle on the right to reorder; "Reset settings" restores the factory order
- **Custom model prices**: enter a model name and "Add" to create an entry; "Edit" opens the editor and changes are written on save; tick "peak / off-peak pricing" to split by time of day, otherwise a flat all-day price applies
- **Currency**: CNY or USD in the top-right corner of the editor. Switching replaces the two built-in models with that currency's official reference prices (edited entries are kept) and changes the symbol in the cost fields; the balance follows the currency reported by the API
- **Holidays**: "Update holidays" fetches and writes the next year's public-holiday calendar
- **Balance**: refreshed once a minute

### Billing rules

Peak hours are **09:00–12:00 and 14:00–18:00 Beijing time, Monday to Friday**, and off-peak rates are half the peak rates; Chinese public holidays and weekends are billed off-peak all day (matching the [official docs](https://api-docs.deepseek.com/quick_start/pricing), checked 2026-09).

![Custom model prices](docs/pricing.en.png)

## Known limitations

- Fastest / slowest TTFT and speed come from a new host-side projection: **you must fully quit and restart DSH** before it starts collecting
- A model with no price is not billed; adding the price back-fills its earlier calls

## Development

```powershell
node tools/test.cjs
```

## Licence

[MIT](LICENSE): free to use, modify and redistribute, including commercially; keep the copyright and licence notice.
