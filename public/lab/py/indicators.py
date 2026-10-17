"""Indicators for MEDUSA Lab strategies (numpy only). Every function returns an array the same
length as its input, where value i uses only data up to and including candle i (no look-ahead).
Values that can't be computed yet are NaN."""
import numpy as np
from numpy.lib.stride_tricks import sliding_window_view


def _f(x):
    return np.asarray(x, dtype=float)


def ema(x, n):
    """Exponential moving average, k = 2 / (n + 1), seeded with the first value (as the demo bot does).
    Missing values (NaN, for example before another indicator is ready) are skipped."""
    x = _f(x)
    out = np.full(len(x), np.nan)
    k = 2.0 / (n + 1)
    prev = None
    for i, v in enumerate(x):
        if v != v:
            continue
        prev = v if prev is None else v * k + prev * (1 - k)
        out[i] = prev
    return out


def rma(x, n):
    """Wilder's moving average (alpha = 1/n), seeded with the first value; NaN values are skipped."""
    x = _f(x)
    out = np.full(len(x), np.nan)
    prev = None
    for i, v in enumerate(x):
        if v != v:
            continue
        prev = v if prev is None else (prev * (n - 1) + v) / n
        out[i] = prev
    return out


def sma(x, n):
    """Simple moving average of the last n values (NaN while any of them is missing)."""
    x = _f(x)
    out = np.full(len(x), np.nan)
    if len(x) >= n:
        bad = np.isnan(x)
        c = np.cumsum(np.insert(np.where(bad, 0.0, x), 0, 0.0))
        out[n - 1:] = (c[n:] - c[:-n]) / n
        if bad.any():
            k = np.cumsum(np.insert(bad, 0, False).astype(np.int64))
            out[n - 1:][(k[n:] - k[:-n]) > 0] = np.nan
    return out


def stdev(x, n):
    """Rolling population standard deviation over the last n values."""
    x = _f(x)
    out = np.full(len(x), np.nan)
    if len(x) >= n:
        out[n - 1:] = sliding_window_view(x, n).std(axis=1)
    return out


def highest(x, n):
    """Highest of the last n values, including the current one."""
    x = _f(x)
    out = np.full(len(x), np.nan)
    if len(x) >= n:
        out[n - 1:] = sliding_window_view(x, n).max(axis=1)
    return out


def lowest(x, n):
    x = _f(x)
    out = np.full(len(x), np.nan)
    if len(x) >= n:
        out[n - 1:] = sliding_window_view(x, n).min(axis=1)
    return out


def shift(x, k=1):
    """Value from k candles ago (NaN at the start)."""
    x = _f(x)
    out = np.full(len(x), np.nan)
    if k < len(x):
        out[k:] = x[:len(x) - k]
    return out


def true_range(h, l, c):
    h, l, c = _f(h), _f(l), _f(c)
    prev = np.concatenate([[c[0]], c[:-1]]) if len(c) else c
    tr = np.maximum(h - l, np.maximum(np.abs(h - prev), np.abs(l - prev)))
    if len(tr):
        tr[0] = h[0] - l[0]
    return tr


def atr(h, l, c, n, smoothing="wilder"):
    """Average true range. smoothing: "wilder" (TradingView, the trend research) or "ema" (the demo bot)."""
    tr = true_range(h, l, c)
    return rma(tr, n) if smoothing == "wilder" else ema(tr, n)


def rsi(c, n=14):
    """RSI with Wilder smoothing, seeded with the simple average of the first n changes (TradingView's ta.rsi)."""
    c = _f(c)
    out = np.full(len(c), np.nan)
    if len(c) <= n:
        return out
    d = np.diff(c)
    up, dn = np.maximum(d, 0), np.maximum(-d, 0)
    au, ad = up[:n].mean(), dn[:n].mean()
    for i in range(n, len(c)):
        if i > n:
            au = (au * (n - 1) + up[i - 1]) / n
            ad = (ad * (n - 1) + dn[i - 1]) / n
        out[i] = 100.0 if ad == 0 else 100 - 100 / (1 + au / ad)
    return out


def macd(c, fast=12, slow=26, signal=9):
    """(macd line, signal line, histogram)."""
    line = ema(c, fast) - ema(c, slow)
    sig = ema(line, signal)
    return line, sig, line - sig


def bollinger(c, n=20, k=2.0):
    """(middle, upper, lower) with the population standard deviation."""
    mid, sd = sma(c, n), stdev(c, n)
    return mid, mid + k * sd, mid - k * sd


def crossed_above(a, b):
    """True on candle i if a moved from <= b on candle i-1 to > b on candle i. b may be a number."""
    a = _f(a)
    b = np.full(len(a), float(b)) if np.isscalar(b) else _f(b)
    out = np.zeros(len(a), bool)
    out[1:] = (a[1:] > b[1:]) & (a[:-1] <= b[:-1])
    return out


def crossed_below(a, b):
    a = _f(a)
    b = np.full(len(a), float(b)) if np.isscalar(b) else _f(b)
    out = np.zeros(len(a), bool)
    out[1:] = (a[1:] < b[1:]) & (a[:-1] >= b[:-1])
    return out


def linreg(x, n):
    """End point of the least-squares line through the last n values (TradingView's ta.linreg(x, n, 0))."""
    x = _f(x)
    out = np.full(len(x), np.nan)
    if len(x) < n or n < 2:
        return out
    k = np.arange(n, dtype=float)
    sy = np.convolve(x, np.ones(n), "valid")                       # sum of each window
    sky = np.convolve(x, k[::-1], "valid")                         # sum of k * value, k = 0 (oldest) .. n-1 (newest)
    kbar, skk = k.mean(), ((k - k.mean()) ** 2).sum()
    slope = (sky - kbar * sy) / skk
    out[n - 1:] = sy / n + slope * (n - 1 - kbar)
    return out


def keltner(h, l, c, n=20, mult=1.5):
    """(middle, upper, lower): the n-candle simple average of the close ± mult x the n-candle simple average
    of the true range (as in the popular TTM Squeeze scripts)."""
    mid, rng = sma(c, n), sma(true_range(h, l, c), n)
    return mid, mid + mult * rng, mid - mult * rng


def supertrend(h, l, c, n=10, mult=3.0):
    """(line, direction): Olivier Seban's Supertrend, computed as TradingView's ta.supertrend (ATR with Wilder
    smoothing). direction is 1 in an uptrend (the line is under the price) and -1 in a downtrend (above it)."""
    h, l, c = _f(h), _f(l), _f(c)
    m = len(c)
    line, trend = np.full(m, np.nan), np.zeros(m)
    if m < n + 1:
        return line, trend
    a = atr(h, l, c, n)
    hl2 = (h + l) / 2
    lo_b, up_b = hl2 - mult * a, hl2 + mult * a
    lo, up, d = lo_b[0], up_b[0], -1
    for i in range(1, m):
        lo = max(lo_b[i], lo) if c[i - 1] >= lo else lo_b[i]       # the lower band only rises while closes stay above it
        up = min(up_b[i], up) if c[i - 1] <= up else up_b[i]       # the upper band only falls while closes stay below it
        if d == -1 and c[i] > up:
            d = 1
        elif d == 1 and c[i] < lo:
            d = -1
        if i >= n:
            trend[i] = d
            line[i] = lo if d == 1 else up
    return line, trend


# ---------- sessions, for intraday strategies ----------
# Crypto trades around the clock, so a "session" is a 24-hour day starting at `start_hour` UTC
# (0 = midnight UTC; 13.5 = 13:30 UTC, when US stocks open). t is the candles' open times in ms.

DAY_MS = 86_400_000


def session_ids(t, start_hour=0.0):
    """The session (day) number of every candle; candles with the same number are in the same session."""
    off = int(round(float(start_hour) * 3_600_000))
    return (np.asarray(t, dtype=np.int64) - off) // DAY_MS


def session_clock(t, interval_ms, start_hour=0.0):
    """(minutes from the session start to each candle's CLOSE, True where the candle is the session's last).
    Both come from the clock alone, so they never look ahead."""
    off = int(round(float(start_hour) * 3_600_000))
    since = (np.asarray(t, dtype=np.int64) - off) % DAY_MS + int(interval_ms)
    return since / 60_000.0, since >= DAY_MS


def session_vwap(h, l, c, v, t, start_hour=0.0):
    """(vwap, sd): the volume-weighted average price of the session so far (typical price (h+l+c)/3, reset
    at every session start) and the volume-weighted standard deviation of the typical price around it, for
    VWAP bands. Until the session has volume: the typical price, sd 0."""
    h, l, c, v = _f(h), _f(l), _f(c), _f(v)
    tp = (h + l + c) / 3
    vwap, sd = tp.copy(), np.zeros(len(tp))
    s = session_ids(t, start_hour)
    starts = np.flatnonzero(np.r_[True, s[1:] != s[:-1]]) if len(s) else np.zeros(0, dtype=np.int64)
    for a, b in zip(starts.tolist(), np.r_[starts[1:], len(s)].tolist()):
        x = tp[a:b] - tp[a]                                         # prices relative to the session's first: exact sums
        vv = np.cumsum(v[a:b])
        m1, m2 = np.cumsum(x * v[a:b]), np.cumsum(x * x * v[a:b])
        ok = vv > 0
        safe = np.where(ok, vv, 1.0)
        mean = np.where(ok, m1 / safe, x)
        vwap[a:b] = mean + tp[a]
        sd[a:b] = np.sqrt(np.maximum(np.where(ok, m2 / safe - mean * mean, 0.0), 0.0))
    return vwap, sd


# ---------- more moving averages ----------

def wma(x, n):
    """Weighted moving average: the newest value weighs n, the oldest 1 (TradingView's ta.wma)."""
    x = _f(x)
    out = np.full(len(x), np.nan)
    if len(x) >= n:
        w = np.arange(1, n + 1, dtype=float)
        out[n - 1:] = np.convolve(x, w[::-1], "valid") / w.sum()
    return out


def hma(x, n):
    """Hull moving average: wma(2 x wma(n/2) - wma(n), sqrt(n)), fast and smooth."""
    return wma(2 * wma(x, max(1, n // 2)) - wma(x, n), max(1, int(np.sqrt(n))))


def dema(x, n):
    """Double EMA: 2 x ema - ema(ema)."""
    e = ema(x, n)
    return 2 * e - ema(e, n)


def tema(x, n):
    """Triple EMA: 3 x e1 - 3 x e2 + e3."""
    e1 = ema(x, n)
    e2 = ema(e1, n)
    return 3 * e1 - 3 * e2 + ema(e2, n)


def zlema(x, n):
    """Zero-lag EMA: the EMA of x + (x - x from (n-1)/2 candles ago)."""
    x = _f(x)
    return ema(x + (x - shift(x, (n - 1) // 2)), n)


def vwma(c, v, n):
    """Volume-weighted moving average of the close over n candles."""
    c, v = _f(c), _f(v)
    return sma(c * v, n) / sma(v, n)


def kama(x, n=10, fast=2, slow=30):
    """Kaufman's adaptive moving average: fast in trends, slow in noise (efficiency ratio over n)."""
    x = _f(x)
    out = np.full(len(x), np.nan)
    if len(x) <= n:
        return out
    fs, ss = 2.0 / (fast + 1), 2.0 / (slow + 1)
    vol = np.abs(np.diff(x))
    prev = x[n - 1]
    for i in range(n, len(x)):
        noise = vol[i - n:i].sum()
        er = abs(x[i] - x[i - n]) / noise if noise > 0 else 0.0
        sc = (er * (fs - ss) + ss) ** 2
        prev = prev + sc * (x[i] - prev)
        out[i] = prev
    return out


# ---------- oscillators ----------

def _ratio(num, den, empty=np.nan):
    """num / den, `empty` where den is 0, NaN where either is NaN."""
    num, den = _f(num), _f(den)
    with np.errstate(divide="ignore", invalid="ignore"):
        out = np.where(den != 0, num / np.where(den != 0, den, 1.0), empty)
    out[np.isnan(num) | np.isnan(den)] = np.nan
    return out


def roc(x, n=10):
    """Rate of change: % change over n candles."""
    x = _f(x)
    return 100 * (x / shift(x, n) - 1)


def momentum(x, n=10):
    """Change over n candles (price units)."""
    x = _f(x)
    return x - shift(x, n)


def stoch(h, l, c, k=14, d=3, smooth=1):
    """(%K, %D) stochastic: where the close sits in the k-candle range (0-100); %K smoothed over `smooth`, %D = sma(%K, d)."""
    hh, ll = highest(h, k), lowest(l, k)
    raw = 100 * _ratio(_f(c) - ll, hh - ll)
    kk = sma(raw, smooth) if smooth > 1 else raw
    return kk, sma(kk, d)


def stoch_rsi(c, rsi_len=14, stoch_len=14, k=3, d=3):
    """(%K, %D) stochastic of the RSI (TradingView's Stoch RSI)."""
    r = rsi(c, rsi_len)
    return stoch(r, r, r, stoch_len, d, k)


def williams_r(h, l, c, n=14):
    """Williams %R: 0 at the top of the n-candle range, -100 at the bottom."""
    hh, ll = highest(h, n), lowest(l, n)
    return -100 * _ratio(hh - _f(c), hh - ll)


def cci(h, l, c, n=20):
    """Commodity channel index: (typical price - its average) / (0.015 x mean deviation)."""
    tp = (_f(h) + _f(l) + _f(c)) / 3
    out = np.full(len(tp), np.nan)
    if len(tp) >= n:
        w = sliding_window_view(tp, n)
        m = w.mean(axis=1)
        md = np.abs(w - m[:, None]).mean(axis=1)
        out[n - 1:] = _ratio(tp[n - 1:] - m, 0.015 * md, 0.0)
    return out


def mfi(h, l, c, v, n=14):
    """Money flow index: an RSI weighted by volume (0-100)."""
    tp = (_f(h) + _f(l) + _f(c)) / 3
    flow = tp * _f(v)
    up = np.r_[np.nan, np.where(np.diff(tp) > 0, flow[1:], 0.0)]
    dn = np.r_[np.nan, np.where(np.diff(tp) < 0, flow[1:], 0.0)]
    su, sd = sma(up, n), sma(dn, n)
    return 100 - 100 / (1 + _ratio(su, sd, np.inf))


def cmo(x, n=9):
    """Chande momentum oscillator (-100 to 100)."""
    d = np.r_[np.nan, np.diff(_f(x))]
    su, sd = sma(np.where(np.isnan(d), np.nan, np.maximum(d, 0)), n), sma(np.where(np.isnan(d), np.nan, np.maximum(-d, 0)), n)
    return 100 * _ratio(su - sd, su + sd, 0.0)


def tsi(x, long=25, short=13):
    """True strength index (x 100): double-smoothed momentum over double-smoothed absolute momentum."""
    d = np.r_[np.nan, np.diff(_f(x))]
    return 100 * _ratio(ema(ema(d, long), short), ema(ema(np.abs(d), long), short), 0.0)


def ultimate(h, l, c, a=7, b=14, cc=28):
    """Ultimate oscillator (0-100) over three lengths."""
    h, l, c = _f(h), _f(l), _f(c)
    pc = shift(c)
    lo, hi = np.minimum(l, pc), np.maximum(h, pc)             # NaN on the first candle: no previous close yet
    bp, tr = c - lo, hi - lo
    avg = [_ratio(sma(bp, n), sma(tr, n)) for n in (a, b, cc)]
    return 100 * (4 * avg[0] + 2 * avg[1] + avg[2]) / 7


def awesome(h, l, fast=5, slow=34):
    """Awesome oscillator: sma(hl2, 5) - sma(hl2, 34)."""
    m = (_f(h) + _f(l)) / 2
    return sma(m, fast) - sma(m, slow)


def trix(c, n=18):
    """TRIX: 10,000 x the change of the triple EMA of log(close) (TradingView's version)."""
    e = ema(ema(ema(np.log(_f(c)), n), n), n)
    return 10000 * (e - shift(e))


def ppo(c, fast=12, slow=26, signal=9):
    """(PPO, signal, histogram): MACD as a % of the slow EMA."""
    s = ema(c, slow)
    line = 100 * (ema(c, fast) - s) / s
    sig = ema(line, signal)
    return line, sig, line - sig


def dpo(c, n=20):
    """Detrended price oscillator, not centred (no look-ahead): close - the n-candle average from n/2 + 1 candles ago."""
    return _f(c) - shift(sma(c, n), n // 2 + 1)


def elder_ray(h, l, c, n=13):
    """(bull power, bear power): high - ema(close), low - ema(close)."""
    e = ema(c, n)
    return _f(h) - e, _f(l) - e


# ---------- trend ----------

def adx(h, l, c, n=14, smooth=14):
    """(+DI, -DI, ADX): Wilder's directional movement (TradingView's ta.dmi)."""
    h, l, c = _f(h), _f(l), _f(c)
    up, dn = np.r_[np.nan, np.diff(h)], np.r_[np.nan, -np.diff(l)]
    pdm = np.where((up > dn) & (up > 0), up, 0.0)
    mdm = np.where((dn > up) & (dn > 0), dn, 0.0)
    pdm[0] = mdm[0] = np.nan
    tr = true_range(h, l, c).copy()
    tr[0] = np.nan
    atr_ = rma(tr, n)
    pdi, mdi = 100 * _ratio(rma(pdm, n), atr_), 100 * _ratio(rma(mdm, n), atr_)
    dx = 100 * _ratio(np.abs(pdi - mdi), pdi + mdi, 0.0)
    return pdi, mdi, rma(dx, smooth)


def aroon(h, l, n=25):
    """(up, down) 0-100: how recently the highest high / lowest low of the last n+1 candles was made (100 = now)."""
    h, l = _f(h), _f(l)
    up, dn = np.full(len(h), np.nan), np.full(len(h), np.nan)
    if len(h) > n:
        wh, wl = sliding_window_view(h, n + 1), sliding_window_view(l, n + 1)
        ago_h = np.argmax(wh[:, ::-1], axis=1)          # 0 = this candle; the most recent extreme counts
        ago_l = np.argmin(wl[:, ::-1], axis=1)
        up[n:] = 100 * (n - ago_h) / n
        dn[n:] = 100 * (n - ago_l) / n
    return up, dn


def psar(h, l, c, start=0.02, inc=0.02, maximum=0.2):
    """(SAR, direction) Parabolic SAR, line for line as TradingView's ta.sar; direction 1 = SAR under the price."""
    h, l, c = _f(h), _f(l), _f(c)
    n = len(c)
    out, dirs = np.full(n, np.nan), np.zeros(n)
    result = mm = acc = 0.0
    below = True
    for i in range(1, n):
        first = False
        if i == 1:
            below = c[1] > c[0]
            mm = h[1] if below else l[1]
            result = l[0] if below else h[0]
            first, acc = True, start
        result = result + acc * (mm - result)
        if below:
            if result > l[i]:
                first, below, result, mm, acc = True, False, max(h[i], mm), l[i], start
        elif result < h[i]:
            first, below, result, mm, acc = True, True, min(l[i], mm), h[i], start
        if not first:
            if below and h[i] > mm:
                mm, acc = h[i], min(acc + inc, maximum)
            elif not below and l[i] < mm:
                mm, acc = l[i], min(acc + inc, maximum)
        if below:
            result = min(result, l[i - 1], l[i - 2]) if i > 1 else min(result, l[i - 1])
        else:
            result = max(result, h[i - 1], h[i - 2]) if i > 1 else max(result, h[i - 1])
        out[i], dirs[i] = result, 1 if below else -1
    return out, dirs


def vortex(h, l, c, n=14):
    """(VI+, VI-) vortex indicator."""
    h, l, c = _f(h), _f(l), _f(c)
    vp = np.r_[np.nan, np.abs(h[1:] - l[:-1])]
    vm = np.r_[np.nan, np.abs(l[1:] - h[:-1])]
    tr = true_range(h, l, c).copy()
    tr[0] = np.nan
    s = sma(tr, n)
    return _ratio(sma(vp, n), s), _ratio(sma(vm, n), s)


def donchian(h, l, n=20):
    """(upper, lower, middle) of the last n candles, this one included (shift() it to compare a close with the previous n)."""
    up, lo = highest(h, n), lowest(l, n)
    return up, lo, (up + lo) / 2


def ichimoku(h, l, tenkan=9, kijun=26, senkou=52):
    """(conversion, base, span A, span B) as they stand at each candle: the spans are the values computed
    kijun candles earlier (the cloud is drawn ahead), so they never look ahead."""
    mid = lambda k: (highest(h, k) + lowest(l, k)) / 2
    tk, kj = mid(tenkan), mid(kijun)
    return tk, kj, shift((tk + kj) / 2, kijun), shift(mid(senkou), kijun)


def chandelier(h, l, c, n=22, mult=3.0):
    """(long stop, short stop): highest high - mult x ATR, lowest low + mult x ATR."""
    a = atr(h, l, c, n)
    return highest(h, n) - mult * a, lowest(l, n) + mult * a


def linreg_slope(x, n):
    """Slope of the least-squares line through the last n values (per candle)."""
    x = _f(x)
    out = np.full(len(x), np.nan)
    if len(x) < n or n < 2:
        return out
    k = np.arange(n, dtype=float)
    sy = np.convolve(x, np.ones(n), "valid")
    sky = np.convolve(x, k[::-1], "valid")
    out[n - 1:] = (sky - k.mean() * sy) / ((k - k.mean()) ** 2).sum()
    return out


# ---------- volatility ----------

def bb_percent(c, n=20, k=2.0):
    """%B: where the close sits between the Bollinger Bands (0 = lower, 1 = upper)."""
    _, up, lo = bollinger(c, n, k)
    return _ratio(_f(c) - lo, up - lo)


def bb_width(c, n=20, k=2.0):
    """Bollinger band width: (upper - lower) / middle."""
    mid, up, lo = bollinger(c, n, k)
    return _ratio(up - lo, mid)


def natr(h, l, c, n=14):
    """ATR as a % of the close."""
    return 100 * atr(h, l, c, n) / _f(c)


def chop(h, l, c, n=14):
    """Choppiness index (about 38 trending to 62 choppy)."""
    s = sma(true_range(h, l, c), n) * n
    r = _ratio(s, highest(h, n) - lowest(l, n))
    with np.errstate(divide="ignore", invalid="ignore"):
        return 100 * np.log10(r) / np.log10(n)


def hist_vol(c, n=20, per_year=365):
    """Historical volatility: yearly % standard deviation of log returns over n candles
    (per_year = candles in a year: 365 for daily, 2190 for 4h, 8760 for 1h, 35040 for 15m)."""
    r = np.r_[np.nan, np.diff(np.log(_f(c)))]
    return 100 * stdev(r, n) * np.sqrt(per_year)


def zscore(x, n=20):
    """How many standard deviations x is from its n-candle average."""
    x = _f(x)
    return _ratio(x - sma(x, n), stdev(x, n), 0.0)


def percent_rank(x, n=100):
    """% of the previous n values that are at or below the current one (TradingView's ta.percentrank)."""
    x = _f(x)
    out = np.full(len(x), np.nan)
    if len(x) > n:
        w = sliding_window_view(x[:-1], n)
        out[n:] = 100 * (w <= x[n:, None]).sum(axis=1) / n
    return out


# ---------- volume ----------

def obv(c, v):
    """On-balance volume: volume added on up closes, subtracted on down closes."""
    c, v = _f(c), _f(v)
    return np.cumsum(np.r_[0.0, np.sign(np.diff(c)) * v[1:]])


def acc_dist(h, l, c, v):
    """Accumulation/distribution line."""
    h, l, c, v = _f(h), _f(l), _f(c), _f(v)
    return np.cumsum(_ratio((c - l) - (h - c), h - l, 0.0) * v)


def cmf(h, l, c, v, n=20):
    """Chaikin money flow over n candles (-1 to 1)."""
    h, l, c, v = _f(h), _f(l), _f(c), _f(v)
    return _ratio(sma(_ratio((c - l) - (h - c), h - l, 0.0) * v, n), sma(v, n))


# ---------- candles, levels and helpers ----------

def heikin_ashi(o, h, l, c):
    """(open, high, low, close) of Heikin-Ashi candles."""
    o, h, l, c = _f(o), _f(h), _f(l), _f(c)
    hc = (o + h + l + c) / 4
    ho = np.empty_like(hc)
    if len(hc):
        ho[0] = (o[0] + c[0]) / 2
        for i in range(1, len(hc)):
            ho[i] = (ho[i - 1] + hc[i - 1]) / 2
    return ho, np.maximum.reduce([h, ho, hc]), np.minimum.reduce([l, ho, hc]), hc


def pivots(h, l, c, t, start_hour=0.0):
    """(P, R1, S1, R2, S2) classic floor pivots from the PREVIOUS session's high, low and close
    (a session is a 24-hour day from start_hour UTC). NaN in the first session."""
    h, l, c = _f(h), _f(l), _f(c)
    s = session_ids(t, start_hour)
    out = [np.full(len(c), np.nan) for _ in range(5)]
    if not len(c):
        return tuple(out)
    starts = np.flatnonzero(np.r_[True, s[1:] != s[:-1]])
    ends = np.r_[starts[1:], len(c)]
    for g in range(1, len(starts)):
        a, b = starts[g - 1], ends[g - 1]
        hi, lo, cl = h[a:b].max(), l[a:b].min(), c[b - 1]
        p = (hi + lo + cl) / 3
        for arr, v in zip(out, (p, 2 * p - lo, 2 * p - hi, p + (hi - lo), p - (hi - lo))):
            arr[starts[g]:ends[g]] = v
    return tuple(out)


def rising(x, n=1):
    """True where x went up on each of the last n candles."""
    x = _f(x)
    up = np.r_[np.nan, (x[1:] > x[:-1]).astype(float)]
    return sma(up, n) == 1


def falling(x, n=1):
    """True where x went down on each of the last n candles."""
    x = _f(x)
    dn = np.r_[np.nan, (x[1:] < x[:-1]).astype(float)]
    return sma(dn, n) == 1


def bars_since(cond):
    """Candles since cond was last True (0 on that candle; NaN before it ever was)."""
    cond = np.asarray(cond, dtype=bool)
    out = np.full(len(cond), np.nan)
    last = -1
    for i, v in enumerate(cond):
        if v:
            last = i
        if last >= 0:
            out[i] = i - last
    return out
