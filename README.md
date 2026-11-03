# 📵 Facebook Reels Limiter

Don't want to get stuck watching Facebook reels but also don't want to get locked out of Facebook when you just leave it open and go afk? This is the script for you!

A Tampermonkey script that lets you only watch a certain amount of Facebook reels in succession but also notices when you're afk.

## ✨ Features

- ⏱ **Live "Time Wasted" Tracker**  
  Shows how long you've spent watching Reels during this session.

- 📊 **Progress Bar Counter**  
  See how many Reels you've watched out of your session limit. Scrolling back to a Reel you've already seen doesn't count it again.

- ⛔ **Automatic Blocking**  
  After watching too many Reels, a countdown screen covers Reels for a cooldown period. Facebook's top bar (Home, search, Messenger, notifications) stays usable, and the rest of Facebook works normally.

- ▶️ **You Choose When To Continue**  
  When the cooldown ends, nothing starts playing on its own. Press **Resume** to watch the Reel you were blocked on, or scroll / use the arrow keys to move on to a new one.

- 🎯 **SPA-Aware**  
  Works with Facebook's single-page app navigation (no page reloads needed).

- 🧠 **Smart Reset**  
  If you're inactive (not switching to new Reels) for 10 minutes, your count resets.

## 🛠 Installation

1. **Install [Tampermonkey](https://www.tampermonkey.net/)** for your browser.
2. **Click to install the script**:  
   [Install from GitHub (raw)](https://raw.githubusercontent.com/dianx93/facebook-reels-limiter/main/facebook-reels-limiter.user.js)  

3. Reload Facebook and start scrolling Reels. The tracker appears automatically.

## ⚙️ Configuration

Edit these constants at the top of the script to customize:

```js
const MAX_REELS = 20;           // Block after watching 20 reels
const BLOCK_DURATION_M = 15;    // Time Facebook stays blocked for 15 minutes
const INACTIVITY_RESET_M = 10;  // Reset counter if inactive for 10 mins
