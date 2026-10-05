<h1 align="center">dsh-desktop-statusbar</h1>

<p align="center">
  <a href="https://github.com/raphael-y7/dsh-desktop-statusbar/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/raphael-y7/dsh-desktop-statusbar?style=social"></a>
  <a href="https://github.com/deepseek-ai/deepseek-harness"><img alt="DeepSeek Harness" src="https://img.shields.io/badge/DeepSeek%20Harness-0.2.0--rc.2-%234d6bfe"></a>
  <a href="https://dshfind.com/zh/plugins/raphael-y7/dsh-desktop-statusbar"><img alt="dshfind" src="https://img.shields.io/badge/dshfind-listed-%2300a884"></a>
  <a href="https://deepseek1024.com/plugins/Rapheal-Y7/dsh-desktop-statusbar"><img alt="1024Store" src="https://img.shields.io/badge/1024Store-listed-orange"></a>
  <a href="https://www.npmjs.com/package/dsh-desktop-statusbar"><img alt="npm version" src="https://img.shields.io/npm/v/dsh-desktop-statusbar?color=red"></a>
  <br>
  <a href="https://nodejs.org/"><img alt="node" src="https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-%238b5cf6"></a>
  <img alt="language" src="https://img.shields.io/github/languages/top/raphael-y7/dsh-desktop-statusbar?color=yellow">
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-%235fa04e"></a>
</p>

<p align="center"><a href="README.md">中文</a> | English</p>

Replaces the stats line under the message input in the DSH desktop app with a configurable status bar: fields, ordering, per-model prices and currency are all configurable, with live cost estimates using DeepSeek's official peak/off-peak rates.

![Status bar](docs/statusbar.en.png)

## Features

- **10 optional fields**: context occupancy (the ring at the head of the bar), peak / off-peak check, turns & steps, cache hit rate, output speed, TTFT, run time, this turn cost, session cost, balance
- **Click a field for details**:

  | Field | Content |
  | --- | --- |
  | Context ring (bar head) | System prompt / tool definitions / messages |
  | Peak / off-peak check | Usage heat map: day / week / month / year |
  | Turns & steps | Context compactions / skills injected / tool calls |
  | Combined hit | This turn / highest / lowest cache hit rate |
  | TPS | This turn / fastest / slowest speed |
  | TTFT | This turn / fastest / slowest first-token delay |
  | Run time | Wait time / model time / tool calls |
  | This turn cost | Token breakdown for this turn |
  | Session cost | Cumulative token breakdown for this session |
  | Balance | Top-up balance / granted balance / quota left |

- **Session data drill-down**: context compactions mark the node they happened at, skills injected counts the skills injected in this session, and tool calls list every tool the session used by count; click the title to go back up
- **Version check and update**: DSH checks for the latest version on startup, shows a hint next to the "Status bar" nav item when one is available, and offers a one-click update button in settings
- **GitHub support**: your support is the biggest motivation for the developer to keep going! Click the button to open the GitHub project page and help with a star — thanks, everyone!
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

- **Context occupancy**: the ring at the head of the bar — progress shows the share of context used, the gap marks the compaction threshold, and the colour shows the run state (grey idle / green running / red error / amber pending approval)
- **Stats fields**: ticking controls visibility only, so unticking hides a field without moving it; drag the handle on the right to reorder; "Reset settings" restores the factory order
- **Custom model prices**: enter a model name and "Add" to create an entry; "Edit" opens the editor and changes are written on save; tick "peak / off-peak pricing" to split by time of day, otherwise a flat all-day price applies
- **Currency**: CNY or USD in the top-right corner of the editor. Switching replaces the two built-in models with that currency's official reference prices (edited entries are kept) and changes the symbol in the cost fields; the balance follows the currency reported by the API
- **Holidays**: click "Update holidays" to fetch and write the next year's public-holiday calendar
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

[MIT](LICENSE): free to use, modify and redistribute; keep the copyright and licence notice.
