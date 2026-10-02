// @xsj/dsh-rewind — client half (permanent bundle plugin, no build step).
//
// Classic-script bundle contract: executing this file only REGISTERS the
// factory; the web module system materializes it once at mount. Externals
// (react, ui primitives) resolve through the shell's frozen module table.
//
// What the user sees:
//   - every user message row carries a rewind/edit action beside copy;
//   - clicking it interrupts any running turn, pre-fills the composer
//     (unsent, editable), and fades the abandoned continuation below it;
//   - while a rewind is pending, the same ✕ cancel button appears at the
//     far right of the state banner; Esc also cancels from the focused
//     composer, clears draft and attachments, and sends nothing;
//   - after the next send, the old excluded branch remains visible but muted,
//     while the model receives only the retained history plus the new message;
//   - the durable log keeps every event (see the host half).
//
// Rewind presentation is geometry-preserving: rows receive only a data marker
// used for opacity/pointer styling. No row is removed from layout, so DSH's
// transcript ResizeObserver/follow-tail policy is not triggered by rewind UI.

window.__ModuleLoader__.load({
  id: '@steycr/dsh-rewind',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    var UiPrimitives = require('@deepseek-ai/dsh-client-ui-primitives')

    var API = '/api/xsj-rewind'

    // ---------------------------------------------------------------- http --
    function post(path, body) {
      return fetch(API + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).then((r) => r.json()).catch(() => null)
    }
    function get(path) {
      return fetch(API + path).then((r) => r.json()).catch(() => null)
    }

    // ---------------------------------------------- image re-attachment --
    // Rewind pre-fills only the text draft; images must be re-attached to the
    // composer. The composer exposes a hidden <input type=file multiple> whose
    // change handler runs the official intake (createDrafts + addAttachments +
    // image-limit checks). We read each durable image's bytes from the host and
    // feed them back through that same input, so re-attachment inherits every
    // shipped guard instead of bypassing it.
    function b64ToBytes(b64) {
      var bin = atob(b64)
      var bytes = new Uint8Array(bin.length)
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      return bytes
    }

    // Serialized: the composer intake appends whatever the input carries, so two
    // overlapping re-attachments would race on the same <input>. One queue per
    // page keeps each batch's files intact.
    var reattachChain = Promise.resolve()
    var reattachGeneration = new Map()

    function bumpReattachGeneration(sid) {
      var next = (reattachGeneration.get(sid) || 0) + 1
      reattachGeneration.set(sid, next)
      return next
    }

    function cancelReattach(sid) { bumpReattachGeneration(sid) }

    function reattachImages(sid, images) {
      var list = Array.isArray(images) ? images : []
      if (list.length === 0) return Promise.resolve(0)
      var generation = bumpReattachGeneration(sid)
      reattachChain = reattachChain.then(() => reattachBatch(sid, list, generation), () => reattachBatch(sid, list, generation))
      return reattachChain
    }

    function reattachBatch(sid, list, generation) {
      var jobs = list.map((img) => {
        var ref = img && img.attachment ? img.attachment : null
        if (ref === null || ref.attachmentId === undefined) return null
        var q = '/image?sessionId=' + encodeURIComponent(sid) + '&attachmentId=' + encodeURIComponent(String(ref.attachmentId))
        return get(q).then((res) => {
          if (!res || res.ok !== true || typeof res.data !== 'string') throw new Error('image read failed')
          var mediaType = res.mediaType || ref.mediaType || 'image/png'
          var name = res.name || ref.name || 'image.png'
          return new File([b64ToBytes(res.data)], name, { type: mediaType })
        })
      }).filter((job) => job !== null)
      return Promise.all(jobs).then((files) => {
        if (reattachGeneration.get(sid) !== generation) return 0
        var real = files.filter((f) => f instanceof File)
        if (real.length === 0) return 0
        var input = composerFileInput()
        if (input === null) {
          console.warn('[xsj-rewind] composer file input not found — images not re-attached')
          return 0
        }
        try {
          // Reset first: assigning an identical FileList is a no-op and would
          // fire no change event. The intake clears value itself, but a failed
          // previous batch could have left a stale selection behind.
          input.value = ''
          var dt = new DataTransfer()
          real.forEach((f) => dt.items.add(f))
          input.files = dt.files
          if (reattachGeneration.get(sid) !== generation) { input.value = ''; return 0 }
          input.dispatchEvent(new Event('change', { bubbles: true }))
          return real.length
        } catch (e) {
          console.error('[xsj-rewind] reattach failed:', e)
          return 0
        }
      })
    }

    // The composer owns the only multiple-file input, but other plugins may
    // mount their own. Prefer the 0.2.x composer card, then older hosts.
    function composerFileInput() {
      var roots = document.querySelectorAll('[data-composer-card], [data-composer], [data-dsh-composer], form')
      for (var i = 0; i < roots.length; i++) {
        var found = roots[i].querySelector('input[type="file"][multiple]')
        if (found !== null) return found
      }
      return document.querySelector('input[type="file"][multiple]')
    }

    function focusComposerInput() {
      function focus() {
        var input = document.querySelector('[data-composer-card] [data-composer-input][contenteditable="true"]')
        if (input === null || typeof input.focus !== 'function') return
        try { input.focus({ preventScroll: true }) } catch (_) { input.focus() }
        try {
          var selection = window.getSelection && window.getSelection()
          if (selection !== null && typeof document.createRange === 'function') {
            var range = document.createRange()
            range.selectNodeContents(input)
            range.collapse(false)
            selection.removeAllRanges()
            selection.addRange(range)
          }
          var scroll = input.closest && input.closest('[data-input-scroll]')
          if (scroll) scroll.scrollTop = scroll.scrollHeight
        } catch (_) { /* focus is sufficient if selection APIs are unavailable */ }
      }
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(focus)
      else setTimeout(focus, 0)
    }

    // ----------------------------------------------- per-session UI state --
    // { pending: null | { targetSeq, markSeq }, ranges: {start,end}[], version,
    //   fetched: bool, fetchFailed: bool }
    // `fetched` distinguishes "the host told us there are no ranges" from "we
    // have not heard back yet". Without it an unknown session and an
    // all-visible session are indistinguishable, so a cold load (or a failed
    // /state read) would render a committed rewind's tail as visible.
    // Bounded: a long-lived page visits many sessions, and an unbounded map
    // would retain one record per session forever. Oldest entries evict first;
    // the composer re-fetches /state when a session becomes active again.
    var MAX_TRACKED_SESSIONS = 24
    var states = new Map()
    var listeners = new Set()
    function readState(sid) { return states.get(sid) }
    function writeState(sid, mut) {
      var prev = states.get(sid)
      states.delete(sid)
      states.set(sid, {
        pending: mut && Object.prototype.hasOwnProperty.call(mut, 'pending') ? mut.pending : prev ? prev.pending : null,
        ranges: mut && Object.prototype.hasOwnProperty.call(mut, 'ranges') ? mut.ranges : prev ? prev.ranges : [],
        // Sticky: once the host has answered for this session, a later write
        // (e.g. a local mark) must not reset the flag and re-blind the driver.
        fetched: mut && Object.prototype.hasOwnProperty.call(mut, 'fetched') ? mut.fetched : prev ? prev.fetched : false,
        fetchFailed: mut && Object.prototype.hasOwnProperty.call(mut, 'fetchFailed') ? mut.fetchFailed : prev ? prev.fetchFailed : false,
        version: (prev ? prev.version : 0) + 1,
      })
      // Map preserves insertion order, so the first key is the least recently
      // written one.
      while (states.size > MAX_TRACKED_SESSIONS) {
        var oldest = states.keys().next()
        if (oldest.done) break
        states.delete(oldest.value)
      }
      Array.from(listeners).forEach((fn) => {
        try { fn() } catch (e) { console.error('[xsj-rewind]', e) }
      })
    }
    function subscribe(fn) {
      listeners.add(fn)
      return function () { listeners.delete(fn) }
    }
    function useRewind(sid) {
      return React.useSyncExternalStore(subscribe, () => readState(sid))
    }
    // =============================================== DOM-native driver ====
    // Per-session resync latch: a module-level flag would let one session's
    // in-flight /state read suppress another session's commit detection.
    var rwResyncing = new Set()
    function rwFlowList() { return document.querySelector('[data-chat-flow]') }
    function rwRows() {
      var list = rwFlowList()
      if (!list) return []
      return Array.prototype.slice.call(list.children).filter((el) => {
        return el.getAttribute && (el.hasAttribute('data-chat-flow-key') || el.hasAttribute('data-chat-anchor-key'))
      })
    }
    function rwSeq(el) {
      var v = el.getAttribute('data-xsj-seq')
      if (v === null || v === '') return null
      var n = Number(v)
      return Number.isFinite(n) ? n : null
    }
    // Only the `user`/`steering` renderers are shadowed by this plugin, so only
    // those rows were ever stamped with their seq. Every other kind — most
    // importantly the model's own `assistant-step` output, plus tool calls,
    // context and command rows — rendered through the shipped renderer and
    // stayed unstamped. A committed range could therefore never hide them:
    // rwSeq() returned null and, once `pending` cleared, the row fell through to
    // the "no evidence" branch — i.e. visible. That is the reported defect: the
    // user message disappears, the model's answer stays on screen.
    //
    // The fix does not need a guessed seq. A hidden range is a contiguous span of
    // the flow, and the flow is rendered in seq order, so a row is inside some
    // range exactly when it sits after a row already known to be hidden and
    // before the next row known to be visible. Stamped rows supply both kinds of
    // evidence — a row is "known hidden" when its seq falls in a committed range
    // or at/after a pending target, and "known visible" when its seq is outside
    // every range and before the pending target. Unstamped rows are then decided
    // by their bracketing, which is what makes the model's output hide with the
    // prompt that produced it.
    function rwRowVerdicts(rows, ranges) {
      var verdicts = new Array(rows.length)
      for (var i = 0; i < rows.length; i++) {
        var seq = rwSeq(rows[i])
        verdicts[i] = seq === null ? null : inRanges(seq, ranges)
      }
      return verdicts
    }
    // Fill an unstamped row from the nearest stamped row before it. Assistant,
    // tool and context rows belong to the user turn that precedes them, so this
    // keeps a committed range visually coherent without inventing seq values.
    // A leading unstamped run falls back to the evidence after it.
    function rwSolveVerdicts(verdicts) {
      var n = verdicts.length
      var before = new Array(n)
      var seen = null
      for (var i = 0; i < n; i++) {
        if (verdicts[i] !== null) seen = verdicts[i]
        before[i] = seen
      }
      var after = new Array(n)
      seen = null
      for (var j = n - 1; j >= 0; j--) {
        if (verdicts[j] !== null) seen = verdicts[j]
        after[j] = seen
      }
      var out = new Array(n)
      for (var k = 0; k < n; k++) {
        if (verdicts[k] !== null) { out[k] = verdicts[k]; continue }
        out[k] = before[k] !== null ? before[k] : after[k] === true
      }
      return out
    }
    function rwSetMuted(el, muted) {
      if (muted) el.setAttribute('data-xsj-rewind-muted', '1')
      else el.removeAttribute('data-xsj-rewind-muted')
    }
    function inRanges(seq, ranges) {
      return ranges.some((r) => seq >= r.start && seq <= r.end)
    }
    // Visual rewind state never changes row geometry. The Host owns model-context
    // truncation; the client only de-emphasizes abandoned history.
    function rwRestoreAll() {
      var marked = document.querySelectorAll('[data-xsj-rewind-muted="1"]')
      for (var i = 0; i < marked.length; i++) rwSetMuted(marked[i], false)
    }
    function rwApply(sid) {
      var rows = rwRows()
      var st = readState(sid)
      // Before the host has answered for this session we know nothing about its
      // committed ranges. Preserve the current presentation until state arrives.
      var unfetched = !st || st.fetched !== true
      if (unfetched && (!st || st.pending == null)) {
        if (st && st.fetchFailed === true) rwRefetch(sid)
        return
      }
      var pending = st.pending
      var ranges = unfetched ? [] : (st.ranges || [])
      if (unfetched && st.fetchFailed === true) rwRefetch(sid)

      var targetIdx = -1
      if (pending) {
        for (var i = 0; i < rows.length; i++) {
          if (rwSeq(rows[i]) === pending.targetSeq) { targetIdx = i; break }
        }
      }

      var committed = rwSolveVerdicts(rwRowVerdicts(rows, ranges))
      var boundary = pending ? (pending.markSeq || pending.targetSeq) : null
      var pendingEnd = rows.length - 1
      var sawNewBranch = false
      if (pending && targetIdx >= 0) {
        for (var q = targetIdx + 1; q < rows.length; q++) {
          var seq = rwSeq(rows[q])
          if (seq !== null && seq > boundary) {
            pendingEnd = q - 1
            sawNewBranch = true
            break
          }
        }
      }

      for (var m = 0; m < rows.length; m++) {
        // While editing, keep the selected message itself readable and fade only
        // the abandoned continuation below it. Once committed, the old selected
        // message joins its durable excluded range and is faded as well.
        var pendingTail = pending !== null && targetIdx >= 0 && m > targetIdx && m <= pendingEnd
        rwSetMuted(rows[m], committed[m] === true || pendingTail)
      }

      // The first newly appended stamped row proves the send committed. Refresh
      // Host state so the old target joins the durable excluded range while the
      // new branch stays active and fully opaque.
      if (pending && sawNewBranch && !rwResyncing.has(sid)) {
        rwResyncing.add(sid)
        get('/state?sessionId=' + encodeURIComponent(sid)).then((res) => {
          rwResyncing.delete(sid)
          if (res) applyHostState(sid, res)
        }).catch(() => { rwResyncing.delete(sid) })
      }
    }

    function applyHostState(sid, res) {
      if (!res || res.ok !== true) return
      writeState(sid, {
        pending: res.pending ? {
          targetSeq: res.pending.targetSeq,
          markSeq: typeof res.pending.markSeq === 'number' ? res.pending.markSeq : res.pending.targetSeq,
        } : null,
        ranges: Array.isArray(res.ranges) ? res.ranges : [],
        fetched: true,
        fetchFailed: false,
      })
    }
    // Read this session's rewind state and record that the host has answered.
    // Resolves true only when a usable answer arrived, so the caller can flag a
    // failure and the driver can retry instead of leaving rows visible.
    function rwLoadState(sid) {
      return get('/state?sessionId=' + encodeURIComponent(sid)).then((res) => {
        if (!res || res.ok !== true) return false
        applyHostState(sid, res)
        return true
      }).catch(() => false)
    }
    // One in-flight retry per session. The retry writes state only when the flag
// actually changes: writeState bumps `version`, which re-runs the driver effect,
// so an unconditional write on every failed retry would schedule the next retry
// and loop forever against a host that stays down.
    var rwRetrying = new Set()
    function rwRefetch(sid) {
      if (rwRetrying.has(sid)) return
      var cur = readState(sid)
      if (cur && cur.fetched === true) return
      rwRetrying.add(sid)
      setTimeout(() => {
        rwRetrying.delete(sid)
        rwLoadState(sid).then((ok) => {
          if (ok) return
          var now = readState(sid)
          // Already flagged: leave the version alone so the driver stays idle
          // until the next real mutation or a fresh mount asks again.
          if (now && now.fetchFailed === true) return
          writeState(sid, { fetchFailed: true })
        })
      }, 2000)
    }

    // -------------------------------------------------------------- i18n --
    var zh = (typeof navigator !== 'undefined' ? navigator.language || '' : '').toLowerCase().indexOf('zh') === 0
    var L = zh ? {
      rewind: '回退到此消息',
      cancel: '取消編輯',
      copy: '复制',
      copied: '已复制',
      banner: '正在編輯此訊息 · 後續訊息不會提供給模型',
      image: '图片',
      extra: '附加数据块',
      truncated: (total) => '已截断（共 ' + total + ' 项）',
    } : {
      rewind: 'Rewind to this message',
      cancel: 'Cancel edit',
      copy: 'Copy',
      copied: 'Copied',
      banner: 'Editing this message · Later messages will not be provided to the model',
      image: 'image',
      extra: 'Extra content block',
      truncated: (total) => 'Truncated (' + total + ' total)',
    }

    // ------------------------------------------------------------ helpers --
    function contentParts(content) {
      var texts = [], images = [], rest = []
      if (Array.isArray(content)) {
        for (var i = 0; i < content.length; i++) {
          var b = content[i]
          if (b && b.type === 'text' && typeof b.text === 'string') texts.push(b.text)
          else if (b && b.type === 'image' && b.attachment !== undefined) images.push({ attachment: b.attachment })
          else rest.push(b)
        }
      }
      return { text: texts.join(''), images: images, rest: rest }
    }
    function pad2(n) { return n < 10 ? '0' + n : String(n) }
    function fmtClock(time) {
      try {
        var d = new Date(time)
        var now = new Date()
        var hm = pad2(d.getHours()) + ':' + pad2(d.getMinutes())
        if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) return hm
        return d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hm
      } catch (e) { return '' }
    }
    function svgIcon(paths) {
      return React.createElement('svg', {
        viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none',
        stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
      }, paths)
    }
    var REWIND_ICON = svgIcon([
      React.createElement('path', { key: 'body', d: 'M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z' }),
      React.createElement('path', { key: 'detail', d: 'm15 5 4 4' }),
    ])
    var CANCEL_ICON = svgIcon([
      React.createElement('path', { key: 'a', d: 'M18 6 6 18' }),
      React.createElement('path', { key: 'b', d: 'M6 6l12 12' }),
    ])
    function iconButton(tooltip, className, icon, handlers) {
      return React.createElement(UiPrimitives.Tooltip, { label: tooltip, side: handlers.side },
        React.createElement('button', {
          type: 'button', className, 'aria-label': tooltip, onClick: handlers.onClick,
          disabled: handlers.disabled,
        }, icon))
    }

    // -------------------------------------------- user message node view --
    // Faithful replacement for the shipped user/steering row (bubble + copy +
    // clock), adding the rewind action. Registered with a shadowing priority
    // so this cell replaces the shipped renderer while the plugin is mounted.
    function UserNodeView(props) {
      var node = props.node
      var data = node && node.data ? node.data : { content: [] }
      var parts = contentParts(data.content)
      var sid = props.sessionId
      var copiedState = React.useState(false)
      var copied = copiedState[0]
      var setCopied = copiedState[1]
      var busyState = React.useState(false)
      var busy = busyState[0]
      var setBusy = busyState[1]
      var rootRef = React.useRef(null)
      React.useLayoutEffect(() => {
        try {
          var el = rootRef.current
          if (!el || !el.closest) return
          var row = el.closest('[data-chat-flow-key]') || el.closest('[data-chat-anchor-key]')
          if (row && typeof data.seq === 'number' && row.getAttribute('data-xsj-seq') !== String(data.seq)) {
            row.setAttribute('data-xsj-seq', String(data.seq))
            window.dispatchEvent(new Event('xsj-rw-stamp'))
          }
        } catch (e) { /* ignore */ }
      })

      function onCopy() {
        if (copied) return
        UiPrimitives.writeClipboard(parts.text).then((ok) => {
          if (ok) setCopied(true)
        }).catch(() => { /* clipboard unavailable */ })
      }
      function onRewind() {
        if (busy) return
        setBusy(true)
        post('/mark', { sessionId: sid, seq: data.seq, preview: parts.text.slice(0, 120) }).then((res) => {
          if (res && res.ok === true) {
            writeState(sid, { pending: {
              targetSeq: data.seq,
              markSeq: typeof res.markSeq === 'number' ? res.markSeq : data.seq,
            } })

            // Entering a rewind replaces the composer state. Invalidate any
            // older async re-attach first, then remove attachments already in
            // the composer so repeated clicks cannot append duplicates.
            cancelReattach(sid)
            if (props.inputActions && typeof props.inputActions.pruneAttachments === 'function') {
              props.inputActions.pruneAttachments([])
            }
            var fileInput = composerFileInput()
            if (fileInput !== null) fileInput.value = ''

            if (props.inputActions && typeof props.inputActions.setDraft === 'function') {
              props.inputActions.setDraft(parts.text)
              focusComposerInput()
            }
            // Re-attach only the selected historical message's images.
            if (parts.images.length > 0) {
              reattachImages(sid, parts.images).catch((e) => {
                console.error('[xsj-rewind] image reattach failed:', e)
              })
            }
          } else {
            console.error('[xsj-rewind] mark rejected:', res && res.error)
          }
        }).catch((e) => {
          console.error('[xsj-rewind] mark failed:', e)
        }).then(() => { setBusy(false) })
      }

      var stackChildren = []
      if (parts.images.length > 0) {
        // attachment module (its client half only exposes apply/inject); the
        // shipped bubble renders images through the renderMessageImages prop,
        // which routes to the conversation.message.images slot. Mirror that.
        // A missing prop must not throw: it would take the whole row — and
        // every sibling row — down with it.
        var renderImages = props.renderMessageImages
        if (typeof renderImages === 'function') {
          stackChildren.push(React.createElement('div', { key: 'images', className: 'xsj-rw-images' },
            renderImages({ images: parts.images, align: 'end', compact: parts.images.length > 1 })))
        } else {
          stackChildren.push(React.createElement('div', { key: 'images', className: 'xsj-rw-images-missing' }, L.image))
        }
      }
      if (parts.text !== '' || parts.rest.length > 0) {
        var bubbleChildren = []
        if (parts.text !== '') {
          // 0.1.5-rc.2 removed primitives.MessageText; the shipped user bubble
          // now renders text through projectUserText (span runs + ref chips),
          // so mirror that here and let CSS handle wrapping.
          bubbleChildren.push(React.createElement('div', { key: 'text', className: 'xsj-rw-text' },
            UiPrimitives.projectUserText(parts.text, [])))
        }
        parts.rest.forEach((block, i) => {
          bubbleChildren.push(React.createElement(UiPrimitives.JsonBlock, {
            key: 'rest-' + i, label: L.extra, payload: block, truncatedLabel: L.truncated,
          }))
        })
        stackChildren.push(React.createElement('div', { key: 'bubble', className: 'xsj-rw-bubble' }, bubbleChildren))
      }

      var actionsChildren = []
      if (typeof data.time === 'number') {
        actionsChildren.push(React.createElement('span', { key: 'clock', className: 'xsj-rw-clock' }, fmtClock(data.time)))
      }
      actionsChildren.push(iconButton(copied ? L.copied : L.copy, 'xsj-rw-action',
        copied ? React.createElement(UiPrimitives.IconCheckOutlineRegular, {}) : React.createElement(UiPrimitives.IconCopyOutlineRegular, {}),
        { onClick: onCopy, side: 'bottom' }))
      actionsChildren.push(iconButton(L.rewind, 'xsj-rw-action xsj-rw-trigger', REWIND_ICON,
        { onClick: onRewind, disabled: busy, side: 'bottom' }))

      return React.createElement('div', { className: 'xsj-rw-row', 'data-time-hover-root': true, ref: rootRef },
        React.createElement('div', { key: 'stack', className: 'xsj-rw-stack' }, stackChildren),
        React.createElement('div', { key: 'actions', className: 'xsj-rw-actions' }, actionsChildren))
    }

    // ---------------------------------------------------- banner + UI driver --
    // The dock entry owns host-state sync, transcript presentation, keyboard
    // cancellation, and the visible cancel-edit action.
    function Banner(props) {
      var sid = props.sessionId
      var st = useRewind(sid)
      var pending = st && st.pending ? st.pending : null

      // Attach: rebuild UI state from the server (covers refresh & restart).
      React.useEffect(() => {
        var live = true
        rwLoadState(sid).then((ok) => {
          if (live && !ok) writeState(sid, { fetchFailed: true })
        })
        return function () { live = false }
      }, [sid])

      // State changes are presentation changes, so apply them before paint.
      // This effect has no cleanup: a version bump must never transiently
      // restore the abandoned tail before applying the next state.
      React.useLayoutEffect(() => {
        try { rwApply(sid) } catch (e) { console.error('[xsj-rewind] apply', e) }
      }, [sid, st ? st.version : 0])

      // DOM changes can add newly rendered rows after the state effect ran.
      // Use a layout effect so old-session cleanup completes before a new
      // session can apply its own presentation state.
      React.useLayoutEffect(() => {
        var t = 0
        function schedule() {
          clearTimeout(t)
          t = setTimeout(() => { try { rwApply(sid) } catch (e) { console.error('[xsj-rewind] apply', e) } }, 0)
        }
        var root = document.querySelector('[data-conversation-scroll]') || document.body
        var obs = new MutationObserver(schedule)
        obs.observe(root, { childList: true, subtree: true })
        window.addEventListener('xsj-rw-stamp', schedule)
        return function () {
          clearTimeout(t)
          obs.disconnect()
          window.removeEventListener('xsj-rw-stamp', schedule)
          try { rwRestoreAll() } catch (e) { console.error('[xsj-rewind] restore', e) }
        }
      }, [sid])

      function onCancel() {
        post('/cancel', { sessionId: sid }).then((res) => {
          if (res && res.ok === true) {
            cancelReattach(sid)
            if (props.inputActions && typeof props.inputActions.setDraft === 'function') props.inputActions.setDraft('')
            if (props.inputActions && typeof props.inputActions.pruneAttachments === 'function') {
              props.inputActions.pruneAttachments([])
            }
            var fileInput = composerFileInput()
            if (fileInput !== null) fileInput.value = ''
            writeState(sid, { pending: null })
          }
        }).catch((e) => { console.error('[xsj-rewind] cancel failed:', e) })
      }

      React.useEffect(() => {
        if (pending === null) return undefined
        function onKeyDown(event) {
          if (event.key !== 'Escape' || event.defaultPrevented) return
          var active = document.activeElement
          if (!active || typeof active.closest !== 'function') return
          if (!active.closest('[data-composer-card], [data-composer], [data-dsh-composer]')) return
          event.preventDefault()
          event.stopPropagation()
          onCancel()
        }
        document.addEventListener('keydown', onKeyDown)
        return function () { document.removeEventListener('keydown', onKeyDown) }
      }, [sid, pending !== null])

      if (pending === null) return null
      return React.createElement('div', { className: 'xsj-rw-banner' },
        React.createElement('span', { className: 'xsj-rw-banner-icon', 'aria-hidden': true }, REWIND_ICON),
        React.createElement('span', { className: 'xsj-rw-banner-text' }, L.banner),
        React.createElement('span', { className: 'xsj-rw-banner-cancel-slot' },
          iconButton(L.cancel, 'xsj-rw-cancel', CANCEL_ICON, { onClick: onCancel, side: 'top' })))
    }

    var BASE_CSS = [
      '.xsj-rw-row{display:flex;flex-direction:column;align-items:flex-end;gap:6px;min-width:0}',
      '.xsj-rw-stack{display:flex;flex-direction:column;align-items:flex-end;gap:8px;min-width:0;max-width:min(525px,82%)}',
      '.xsj-rw-bubble{background:var(--dsw-specific-bubble,rgba(127,127,127,.14));color:var(--dsw-alias-label-primary,inherit);border-radius:22px;padding:10px 16px;font-size:16px;line-height:24px;max-width:100%;box-sizing:border-box;overflow-wrap:anywhere}',
      '.xsj-rw-bubble p{margin:0}',
      '.xsj-rw-images{display:flex;justify-content:flex-end;max-width:100%}',
      '.xsj-rw-images-missing{color:var(--dsw-alias-label-tertiary,#98a2b3);font-size:13px}',
      '.xsj-rw-text{white-space:pre-wrap;word-break:break-word}',
      '.xsj-rw-actions{display:flex;align-items:center;gap:2px;height:28px}',
      '.xsj-rw-clock{color:var(--dsw-alias-label-tertiary,#98a2b3);white-space:nowrap;padding-right:10px;font-size:14px;line-height:24px;font-variant-numeric:tabular-nums}',
      '.xsj-rw-action{width:28px;height:28px;color:var(--dsw-alias-label-tertiary,#98a2b3);cursor:pointer;background:transparent;border:none;border-radius:14px;display:inline-flex;align-items:center;justify-content:center;padding:6px}',
      '.xsj-rw-action:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16));color:var(--dsw-alias-label-secondary,inherit)}',
      '.xsj-rw-action:disabled{opacity:.45;cursor:default}',
      '@media(hover:hover){[data-time-hover-root] .xsj-rw-clock,[data-time-hover-root] .xsj-rw-action{opacity:0;transition:opacity 80ms}[data-time-hover-root]:hover .xsj-rw-clock,[data-time-hover-root]:hover .xsj-rw-action,[data-time-hover-root]:focus-within .xsj-rw-clock,[data-time-hover-root]:focus-within .xsj-rw-action{opacity:1}}',
      '[data-xsj-rewind-muted="1"]{opacity:.28;pointer-events:none;transition:opacity 120ms ease}',
      '@media(prefers-reduced-motion:reduce){[data-xsj-rewind-muted="1"]{transition:none}}',
      '.xsj-rw-cancel{width:28px;height:28px;flex:none;color:var(--dsw-alias-label-secondary,inherit);cursor:pointer;background:transparent;border:none;border-radius:14px;display:inline-flex;align-items:center;justify-content:center;padding:6px}',
      '.xsj-rw-cancel:hover{background:var(--dsw-alias-interactive-bg-hover-danger,rgba(220,60,60,.14));color:var(--dsw-alias-state-error-primary,#d44444)}',
      '.xsj-rw-banner{width:100%;max-width:min(var(--dsh-composer-card-max-width,780px),100%);box-sizing:border-box;display:flex;align-items:center;gap:8px;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-secondary,inherit);border-radius:9999px;padding:6px 8px 6px 12px;font-size:13px;line-height:20px;margin:0 auto 6px}',
      '.xsj-rw-banner-icon{flex:none;display:inline-flex;align-items:center;justify-content:center}',
      '.xsj-rw-banner-text{min-width:0}',
      '.xsj-rw-banner-cancel-slot{margin-left:auto;flex:none;display:flex;align-items:center}',
    ].join('\n')

    // -------------------------------------------------------------- apply --
    function apply(ctx) {
      // Resolve the slots service defensively: a bundle may be evaluated before
      // the slot service is published, and a hard access would throw out of
      // apply() and silently lose every registration below.
      var slots = ctx && (ctx.get ? ctx.get('slots') : ctx.slots)

      var baseTag = document.createElement('style')
      baseTag.setAttribute('data-xsj-rewind', 'base')
      baseTag.textContent = BASE_CSS
      document.head.append(baseTag)

      if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
        console.warn('[xsj-rewind] slots service unavailable — renderer registration skipped')
        return
      }

      // Keyed slots throw on a duplicate same-key/same-priority registration
      // (e.g. a client HMR rebuild racing its own teardown). Guard every
      // registration so one failure cannot take down the others.
      var mounted = []
      function tryRegister(label, options, component) {
        try {
          var dispose = slots.register(options, component)
          mounted.push(label)
          return dispose
        } catch (e) {
          console.warn('[xsj-rewind] register failed for', label, (e && e.message) || e)
          return function () { /* nothing to dispose */ }
        }
      }

      // priority -1 beats the shipped renderer's default 0 (lowest renders), so
      // this plugin owns the row while mounted; unloading restores the shipped
      // one because its own registration was never removed.
      ctx.effect(() => {
        var disposers = [
          slots.inject('conversation.chat.node', () => [
            tryRegister('chat.node:user',
              { name: 'conversation.chat.node', key: 'user', priority: -1 },
              (props) => React.createElement(UserNodeView, props)),
            tryRegister('chat.node:steering',
              { name: 'conversation.chat.node', key: 'steering', priority: -1 },
              (props) => React.createElement(UserNodeView, props)),
          ]),
          slots.inject('conversation.input.dock', () => {
            return tryRegister('input.dock:banner',
              { name: 'conversation.input.dock', id: 'xsj-rewind-banner', order: 90, label: 'rewind' },
              (props) => React.createElement(Banner, props))
          }),
        ]
        if (mounted.length > 0) {
          console.info('[xsj-rewind] client mounted:', mounted.join(', '))
        }
        return () => {
          disposers.forEach((d) => {
            try { d() } catch (e) { /* stale disposer */ }
          })
        }
      })
      ctx.effect(() => () => baseTag.remove())
    }

    exports.name = 'xsj-rewind'
    exports.inject = ['slots']
    exports.apply = apply
    return module.exports
  },
})
