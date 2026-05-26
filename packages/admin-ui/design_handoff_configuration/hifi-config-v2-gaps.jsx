// hifi-config-v2-gaps.jsx — gap-closing screens for the Configuration handoff
// Adds: preamble edit drawer · save-preview modal · field states reference ·
//       archive confirm · add-repo dialog · empty state

// ── Dimmer overlay ───────────────────────────────────────────
function CV2Dimmer({ children, intensity = 0.42 }) {
  return (
    <>
      <div style={{
        position: 'absolute', inset: 0, background: `rgba(14, 14, 12, ${intensity})`,
        backdropFilter: 'blur(1.5px)', zIndex: 5,
      }} />
      <div style={{ position: 'absolute', inset: 0, zIndex: 6, pointerEvents: 'none' }}>{children}</div>
    </>
  );
}

// ═════════════════════════════════════════════════════════════
// 1) PREAMBLE EDIT DRAWER — overlays Global page
// ═════════════════════════════════════════════════════════════
function CV2PreambleDrawer() {
  return (
    <div style={{
      position: 'absolute', top: 0, right: 0, bottom: 0, width: 720,
      background: 'var(--paper)', borderLeft: '1px solid var(--line)',
      boxShadow: '-12px 0 32px rgba(14, 14, 12, 0.18)',
      pointerEvents: 'auto', display: 'flex', flexDirection: 'column',
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{ padding: '16px 22px', borderBottom: '1px solid var(--line)', background: 'var(--paper)' }}>
        <HStack gap={10} style={{ marginBottom: 8 }}>
          <Icon.Anchor size={15} style={{ color: 'var(--accent)' }} />
          <T kind="h2" style={{ letterSpacing: '-0.018em' }}>Worker preamble</T>
          <Badge tone="accent" size="md">v3</Badge>
          <Badge tone="neutral" size="md" variant="outline">global</Badge>
          <Badge tone="neutral" size="md" variant="outline">kind=code</Badge>
          <span style={{ flex: 1 }} />
          <Button variant="ghost" size="sm"><Icon.X size={14} /></Button>
        </HStack>
        <HStack gap={12}>
          <T kind="mono-sm" color="var(--ink-3)">preambles.preamble_id=3</T>
          <T kind="mono-sm" color="var(--ink-4)">·</T>
          <T kind="mono-sm" color="var(--ink-3)">247 attempts reference this version</T>
          <T kind="mono-sm" color="var(--ink-4)">·</T>
          <T kind="mono-sm" color="var(--ink-3)">last edited today, 14:22 by mira</T>
        </HStack>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 14, padding: '0 22px', borderBottom: '1px solid var(--line)', background: 'var(--paper)' }}>
        {['Edit', 'Diff vs v2', 'Versions', 'Used by'].map((l, i) => (
          <div key={l} style={{
            padding: '10px 0', borderBottom: i === 0 ? '2px solid var(--ink)' : '2px solid transparent',
            cursor: 'pointer',
          }}>
            <T kind="body-sm" style={{ fontWeight: i === 0 ? 600 : 500, color: i === 0 ? 'var(--ink)' : 'var(--ink-3)' }}>{l}</T>
          </div>
        ))}
      </div>

      {/* Body */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* Editor */}
        <div style={{ flex: 1, padding: '14px 22px', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div style={{ flex: 1, overflow: 'hidden', background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 'var(--r-md)', display: 'flex', flexDirection: 'column' }}>
            <div style={{ padding: '6px 12px', borderBottom: '1px solid var(--line)', background: 'var(--surface-2)', display: 'flex', alignItems: 'center', gap: 8 }}>
              <Icon.Anchor size={11} style={{ color: 'var(--ink-3)' }} />
              <T kind="mono-sm" color="var(--ink-3)">preamble.md · 1,684 bytes · 8 rules</T>
              <span style={{ flex: 1 }} />
              <T kind="mono-sm" color="var(--accent-ink)">● editing</T>
            </div>
            <div style={{ flex: 1, padding: '10px 0', overflow: 'hidden', fontFamily: 'var(--mono)', fontSize: 12.5, lineHeight: 1.65 }}>
              {WORKER_PREAMBLE_BODY.split('\n').map((line, i) => (
                <div key={i} style={{ display: 'flex', minHeight: 22 }}>
                  <span style={{ width: 38, color: 'var(--ink-4)', textAlign: 'right', padding: '0 12px 0 8px', userSelect: 'none', fontSize: 11 }}>
                    {line.trim() ? i + 1 : ''}
                  </span>
                  <span style={{
                    flex: 1, color: line.match(/^\d+\./) ? 'var(--ink)' : 'var(--ink-2)',
                    whiteSpace: 'pre-wrap', paddingRight: 16,
                    fontWeight: line.match(/^\d+\./) ? 500 : 400,
                  }}>{line || ' '}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Versions */}
        <div style={{ width: 220, borderLeft: '1px solid var(--line)', background: 'var(--paper)', padding: '14px 14px', overflow: 'hidden' }}>
          <HStack gap={6}>
            <T kind="caption">VERSIONS</T>
            <T kind="mono-sm" color="var(--ink-4)">3</T>
          </HStack>
          <T kind="mono-sm" color="var(--ink-3)" style={{ display: 'block', marginTop: 2 }}>append-only</T>
          <div style={{ position: 'relative', marginTop: 12 }}>
            <div style={{ position: 'absolute', left: 11, top: 8, bottom: 8, width: 1, background: 'var(--line)' }} />
            {[
              { v: 3, ts: 'today · 14:22', who: 'mira',  msg: 'Tightened PR-title rules.', current: true, refs: 247 },
              { v: 2, ts: '5d ago',        who: 'mira',  msg: 'Added rule 8 — write blocker instead of clarifying.', refs: 184 },
              { v: 1, ts: '2026-04-12',    who: 'tonio', msg: 'Initial protocol preamble v1.', refs: 412 },
            ].map(v => (
              <div key={v.v} style={{ display: 'flex', gap: 8, padding: '6px 0', position: 'relative' }}>
                <div style={{
                  width: 22, height: 22, borderRadius: '50%', flexShrink: 0,
                  background: v.current ? 'var(--accent-soft)' : 'var(--surface)',
                  border: `1px solid ${v.current ? 'var(--accent-line)' : 'var(--line-2)'}`,
                  color: v.current ? 'var(--accent-ink)' : 'var(--ink-3)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600, zIndex: 1,
                }}>v{v.v}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <HStack gap={5}>
                    <T kind="body-sm" style={{ fontWeight: 500 }}>{v.who}</T>
                    {v.current && <Badge tone="accent" size="sm">cur</Badge>}
                  </HStack>
                  <T kind="mono-sm" color="var(--ink-4)" style={{ display: 'block' }}>{v.ts}</T>
                  <T kind="body-sm" color="var(--ink-2)" style={{ display: 'block', marginTop: 3, lineHeight: 1.35, fontSize: 12 }}>{v.msg}</T>
                  <T kind="mono-sm" color="var(--ink-3)" style={{ display: 'block', marginTop: 2 }}>{v.refs} ref</T>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Footer */}
      <div style={{ padding: '12px 22px', borderTop: '1px solid var(--line)', background: 'var(--paper-2)', display: 'flex', alignItems: 'center', gap: 10 }}>
        <T kind="mono-sm" color="var(--ink-3)">tokens 426</T>
        <T kind="mono-sm" color="var(--ink-4)">·</T>
        <T kind="mono-sm" color="var(--ink-3)">1,684 bytes</T>
        <span style={{ flex: 1 }} />
        <Button variant="ghost" size="md">Discard</Button>
        <Button variant="secondary" size="md">Save as draft</Button>
        <Button variant="primary" size="md">Publish v4 →</Button>
      </div>
    </div>
  );
}

function CV2PreambleDrawerScreen() {
  return (
    <div className="hf" style={{ width: CV2_W, height: 1080, position: 'relative', overflow: 'hidden' }}>
      <HFGlobalStyles />
      {/* Dimmed background — a faked snapshot of the global page */}
      <div style={{ position: 'absolute', inset: 0, filter: 'blur(0px)', opacity: 0.95 }}>
        <CV2GlobalScreen />
      </div>
      <CV2Dimmer intensity={0.4} />
      <div style={{ position: 'absolute', top: 0, right: 0, bottom: 0, width: 720, zIndex: 7 }}>
        <CV2PreambleDrawer />
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════
// 2) SAVE-PREVIEW MODAL
// ═════════════════════════════════════════════════════════════
function CV2SaveModal() {
  return (
    <div style={{
      width: 820, background: 'var(--paper)',
      border: '1px solid var(--line)', borderRadius: 'var(--r-xl)',
      boxShadow: '0 24px 60px rgba(14, 14, 12, 0.28)',
      pointerEvents: 'auto', display: 'flex', flexDirection: 'column',
      overflow: 'hidden',
    }}>
      <div style={{ padding: '16px 22px', borderBottom: '1px solid var(--line)' }}>
        <HStack gap={10} align="baseline">
          <T kind="h2" style={{ letterSpacing: '-0.018em' }}>Review changes</T>
          <Badge tone="accent" size="md">Global</Badge>
          <Badge tone="warn" size="sm">3 fields</Badge>
          <span style={{ flex: 1 }} />
          <T kind="mono-sm" color="var(--ink-3)">esc to close</T>
        </HStack>
        <T kind="body-sm" color="var(--ink-3)" style={{ display: 'block', marginTop: 6 }}>
          Saving writes ~/.quay/config.toml and emits 1 quay repo update call. Active tasks keep their snapshot.
        </T>
      </div>

      <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14, maxHeight: 540, overflow: 'hidden' }}>
        <T kind="caption">CHANGES</T>

        {[
          { field: 'retry_budget',                  scope: 'global',     before: '4', after: '5' },
          { field: 'reviewer.gate_quay_owned_done', scope: 'global',     before: 'true', after: 'false' },
          { field: 'install_cmd',                   scope: 'acme-orders', before: '"bun install"', after: '"bun install --frozen-lockfile"' },
        ].map(c => (
          <div key={c.field} style={{
            background: 'var(--surface)', border: '1px solid var(--line)',
            borderRadius: 'var(--r-sm)', padding: 14,
          }}>
            <HStack gap={8} style={{ marginBottom: 8 }}>
              <T kind="mono" style={{ fontWeight: 500 }}>{c.field}</T>
              <Badge tone="neutral" size="sm" variant="outline">{c.scope}</Badge>
            </HStack>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 24px 1fr', gap: 10, alignItems: 'center' }}>
              <div style={{ padding: '6px 12px', background: 'var(--danger-soft)', border: '1px solid var(--danger-line)', borderRadius: 'var(--r-xs)' }}>
                <T kind="mono-sm" color="var(--ink-3)" style={{ display: 'block' }}>− before</T>
                <T kind="mono-md" style={{ display: 'block', marginTop: 2, color: 'var(--danger-ink)' }}>{c.before}</T>
              </div>
              <Icon.Arrow size={14} dir="right" style={{ color: 'var(--ink-4)', justifySelf: 'center' }} />
              <div style={{ padding: '6px 12px', background: 'var(--good-soft)', border: '1px solid var(--good-line)', borderRadius: 'var(--r-xs)' }}>
                <T kind="mono-sm" color="var(--ink-3)" style={{ display: 'block' }}>+ after</T>
                <T kind="mono-md" style={{ display: 'block', marginTop: 2, color: 'var(--good-ink)' }}>{c.after}</T>
              </div>
            </div>
          </div>
        ))}

        <T kind="caption" style={{ marginTop: 4 }}>EQUIVALENT CLI</T>
        <div style={{ background: '#0E0E0C', border: '1px solid #1F1D17', borderRadius: 'var(--r-sm)', padding: '12px 14px' }}>
          <T kind="mono-sm" style={{ display: 'block', color: '#A39C8E', lineHeight: 1.65, whiteSpace: 'pre-wrap' }}>
{`$ quay config set retry_budget=5
$ quay config set reviewer.gate_quay_owned_done=false
$ quay repo update acme-orders --install-cmd "bun install --frozen-lockfile"`}
          </T>
        </div>

        <T kind="caption" style={{ marginTop: 4 }}>IMPACT</T>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <Card padding={12}>
            <T kind="caption" color="var(--ink-3)" style={{ display: 'block' }}>NEW TASKS</T>
            <T kind="body-sm" color="var(--ink-2)" style={{ display: 'block', marginTop: 4, lineHeight: 1.45 }}>
              Future enqueues see budget=5 and the new install_cmd. Reviewer no longer gates Quay-owned PRs.
            </T>
          </Card>
          <Card padding={12} style={{ background: 'var(--warn-soft)', borderColor: 'var(--warn-line)' }}>
            <T kind="caption" color="var(--warn-ink)" style={{ display: 'block' }}>EXISTING TASKS · 12</T>
            <T kind="body-sm" color="var(--ink-2)" style={{ display: 'block', marginTop: 4, lineHeight: 1.45 }}>
              Keep their snapshot (budget=4, original install_cmd). Existing PRs are no longer reviewer-gated.
            </T>
          </Card>
        </div>
      </div>

      <div style={{ padding: '14px 22px', borderTop: '1px solid var(--line)', background: 'var(--paper-2)', display: 'flex', alignItems: 'center', gap: 10 }}>
        <Chip>Copy CLI</Chip>
        <Chip>Download patch.json</Chip>
        <span style={{ flex: 1 }} />
        <Button variant="ghost" size="md">Cancel</Button>
        <Button variant="primary" size="md">Apply 3 changes</Button>
      </div>
    </div>
  );
}

function CV2SaveModalScreen() {
  return (
    <div className="hf" style={{ width: CV2_W, height: 1000, position: 'relative', overflow: 'hidden' }}>
      <HFGlobalStyles />
      <div style={{ position: 'absolute', inset: 0 }}>
        <CV2GlobalScreen />
      </div>
      <CV2Dimmer intensity={0.45} />
      <div style={{
        position: 'absolute', top: 60, left: '50%', transform: 'translateX(-50%)', zIndex: 7,
      }}>
        <CV2SaveModal />
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════
// 3) FIELD STATES REFERENCE
// ═════════════════════════════════════════════════════════════

function FieldStateExample({ caption, children, note }) {
  return (
    <Card padding={20}>
      <T kind="caption" color="var(--ink-3)" style={{ display: 'block', marginBottom: 12 }}>{caption}</T>
      {children}
      {note && <T kind="body-sm" color="var(--ink-3)" style={{ display: 'block', marginTop: 10, lineHeight: 1.5 }}>{note}</T>}
    </Card>
  );
}

function FocusedField({ label, value, dirty, error, helper }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <T kind="caption" color="var(--ink-3)">{label}</T>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '6px 10px', minHeight: 32,
        background: 'var(--surface)',
        border: `1.5px solid ${error ? 'var(--danger)' : 'var(--accent)'}`,
        borderRadius: 'var(--r-sm)',
        boxShadow: `0 0 0 3px ${error ? 'var(--danger-soft)' : 'var(--accent-soft)'}`,
      }}>
        <span style={{
          fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink)',
          flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{value}</span>
        <span style={{
          width: 1, height: 16, background: 'var(--accent)', marginRight: 2,
          animation: 'cv2-caret 1.1s ease infinite',
        }} />
      </div>
      {error && (
        <HStack gap={5}>
          <Icon.Alert size={11} style={{ color: 'var(--danger)' }} />
          <T kind="mono-sm" color="var(--danger-ink)">{error}</T>
        </HStack>
      )}
      {helper && (
        <T kind="mono-sm" color="var(--ink-3)">{helper}</T>
      )}
    </div>
  );
}

function CV2FieldStates() {
  return (
    <div className="hf" style={{ width: CV2_W, minHeight: 1200, padding: '40px 48px', background: 'var(--paper-2)' }}>
      <HFGlobalStyles />
      <style>{`@keyframes cv2-caret { 0%,40% { opacity: 1 } 60%,100% { opacity: 0 } }`}</style>

      <div style={{ marginBottom: 30 }}>
        <T kind="caption" color="var(--accent-ink)" style={{ display: 'block', marginBottom: 6 }}>REFERENCE</T>
        <T kind="h1" style={{ letterSpacing: '-0.02em' }}>Field states</T>
        <T kind="body" color="var(--ink-3)" style={{ display: 'block', marginTop: 8, maxWidth: 720, lineHeight: 1.55 }}>
          Every field in the configuration UI exists in one of these visual states. Inline-edit applies to text and numeric values; commands and prose open a side drawer.
        </T>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginBottom: 28 }}>
        <FieldStateExample caption="DEFAULT · READ-ONLY VIEW">
          <CV2Field label="INSTALL_CMD" value="bun install --frozen-lockfile" source="repo-only" />
        </FieldStateExample>

        <FieldStateExample caption="HOVER · EDITABLE HINT">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <T kind="caption" color="var(--ink-3)">INSTALL_CMD</T>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '6px 10px', minHeight: 32,
              background: 'var(--surface)', border: '1px solid var(--ink-3)',
              borderRadius: 'var(--r-sm)',
            }}>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink)', flex: 1 }}>bun install --frozen-lockfile</span>
              <T kind="mono-sm" color="var(--ink-3)">click to edit</T>
            </div>
            <T kind="mono-sm" color="var(--ink-3)">repo-only</T>
          </div>
        </FieldStateExample>

        <FieldStateExample caption="FOCUSED · EDITING INLINE">
          <FocusedField
            label="INSTALL_CMD"
            value="bun install --frozen-lockfile|"
            helper="enter to save · esc to cancel"
          />
        </FieldStateExample>

        <FieldStateExample caption="DIRTY · UNSAVED">
          <CV2Field label="INSTALL_CMD" value="bun install --frozen-lockfile" source="repo-only" dirty />
        </FieldStateExample>

        <FieldStateExample caption="ERROR · VALIDATION">
          <FocusedField
            label="INSTALL_CMD"
            value="bun instal --frozen-lockfile|"
            error="unknown command `instal` · did you mean `install`?"
          />
        </FieldStateExample>

        <FieldStateExample caption="DISABLED · COMPUTED">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <T kind="caption" color="var(--ink-3)">BARE_CLONE_PATH</T>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '6px 10px', minHeight: 32,
              background: 'var(--paper-2)', border: '1px dashed var(--line-2)',
              borderRadius: 'var(--r-sm)', opacity: 0.85,
            }}>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-3)', flex: 1, fontStyle: 'italic' }}>
                /var/lib/quay/repos/acme-orders.git
              </span>
              <StatusDot tone="good" />
            </div>
            <HStack gap={5}>
              <Icon.Dot size={9} style={{ color: 'var(--ink-4)' }} />
              <T kind="mono-sm" color="var(--ink-3)">derived from repo_id · not editable</T>
            </HStack>
          </div>
        </FieldStateExample>

        <FieldStateExample caption="INHERITS GLOBAL">
          <CV2Field label="WORKER MODEL" value="claude-opus-4-1" source="inherits" inheritedValue="from [agents].worker_model" />
        </FieldStateExample>

        <FieldStateExample caption="OVERRIDES GLOBAL">
          <CV2Field label="WORKER AGENT" value="hermes_codex_browser" source="override" inheritedValue="claude" />
        </FieldStateExample>

        <FieldStateExample caption="EMPTY · OPTIONAL">
          <CV2Field label="CONTRIBUTION_GUIDE" value={null} source="repo-only" />
        </FieldStateExample>
      </div>

      {/* Chip / select / toggle states */}
      <div style={{ marginBottom: 16 }}>
        <T kind="h2" style={{ letterSpacing: '-0.018em' }}>Editable collections</T>
        <T kind="body" color="var(--ink-3)" style={{ display: 'block', marginTop: 6, maxWidth: 720, lineHeight: 1.55 }}>
          Tag values, capability lists, and agent registry chips. Chips are removable; an inline input appears at the end of the row when you click "+ value".
        </T>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 16, marginBottom: 28 }}>
        <FieldStateExample caption="DEFAULT · CHIP ROW">
          <T kind="caption" color="var(--ink-3)" style={{ display: 'block', marginBottom: 8 }}>area · namespace</T>
          <HStack gap={5} wrap>
            <Chip tone="accent" selected onRemove>area-cart</Chip>
            <Chip tone="accent" selected onRemove>area-checkout</Chip>
            <Chip tone="accent" selected onRemove>area-pricing</Chip>
            <Chip leading={<Icon.Plus size={10} />}>value</Chip>
          </HStack>
        </FieldStateExample>

        <FieldStateExample caption="ADDING · INLINE INPUT">
          <T kind="caption" color="var(--ink-3)" style={{ display: 'block', marginBottom: 8 }}>area · namespace</T>
          <HStack gap={5} wrap>
            <Chip tone="accent" selected onRemove>area-cart</Chip>
            <Chip tone="accent" selected onRemove>area-checkout</Chip>
            <Chip tone="accent" selected onRemove>area-pricing</Chip>
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              height: 22, padding: '0 8px',
              background: 'var(--surface)', border: '1.5px solid var(--accent)',
              borderRadius: 'var(--r-sm)',
              boxShadow: '0 0 0 3px var(--accent-soft)',
            }}>
              <span style={{ fontFamily: 'var(--sans)', fontSize: 12, color: 'var(--ink)' }}>area-refunds|</span>
            </span>
          </HStack>
          <T kind="mono-sm" color="var(--ink-3)" style={{ display: 'block', marginTop: 8 }}>enter to add · esc to cancel</T>
        </FieldStateExample>

        <FieldStateExample caption="SEGMENTED · 3-WAY">
          <T kind="caption" color="var(--ink-3)" style={{ display: 'block', marginBottom: 8 }}>worker preamble · per-repo</T>
          <Segmented value="extend" options={[
            { value: 'inherit', label: 'Inherit' },
            { value: 'extend',  label: 'Extend' },
            { value: 'replace', label: 'Replace' },
          ]} />
        </FieldStateExample>

        <FieldStateExample caption="TOGGLE · BOOLEAN">
          <T kind="caption" color="var(--ink-3)" style={{ display: 'block', marginBottom: 8 }}>adapters.slack.enabled</T>
          <HStack gap={16}>
            <Toggle checked label="On" />
            <Toggle label="Off" />
          </HStack>
        </FieldStateExample>
      </div>

      <Card padding={20} style={{ background: 'var(--paper)' }}>
        <T kind="caption" style={{ display: 'block', marginBottom: 8 }}>FIELD-LEVEL INTERACTION RULES</T>
        <ul style={{ margin: 0, paddingLeft: 18, fontFamily: 'var(--sans)', fontSize: 14, lineHeight: 1.7, color: 'var(--ink-2)' }}>
          <li>Inline-edit applies to text, numbers, paths, and short string values.</li>
          <li>Commands &gt; 80 chars, prose, and preamble bodies open the side drawer instead.</li>
          <li>"Save" is batched at the page level — there is no per-field save button. Sticky footer aggregates dirty fields.</li>
          <li>Esc reverts the focused field. Cmd/Ctrl+Enter triggers "Save changes" globally.</li>
          <li>Validation runs on blur. Errors persist the dirty state and block the global save.</li>
        </ul>
      </Card>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════
// 4) ARCHIVE REPO CONFIRM
// ═════════════════════════════════════════════════════════════
function CV2ArchiveConfirm() {
  return (
    <div style={{
      width: 540, background: 'var(--paper)',
      border: '1px solid var(--line)', borderRadius: 'var(--r-xl)',
      boxShadow: '0 24px 60px rgba(14, 14, 12, 0.32)',
      pointerEvents: 'auto', display: 'flex', flexDirection: 'column',
    }}>
      <div style={{ padding: '20px 22px 14px' }}>
        <HStack gap={10} align="baseline">
          <Icon.Alert size={18} style={{ color: 'var(--danger)' }} />
          <T kind="h2" style={{ letterSpacing: '-0.018em' }}>Archive <span style={{ fontFamily: 'var(--mono)' }}>acme-orders</span>?</T>
        </HStack>
        <T kind="body" color="var(--ink-2)" style={{ display: 'block', marginTop: 12, lineHeight: 1.55 }}>
          5 active tasks will continue running to completion. No new tasks will spawn from this repo.
        </T>
        <T kind="body-sm" color="var(--ink-3)" style={{ display: 'block', marginTop: 8, lineHeight: 1.5 }}>
          This is reversible — archived repos can be restored from the <T kind="mono-sm" color="var(--ink-3)" style={{ background: 'var(--surface-2)', padding: '1px 5px', borderRadius: 3, border: '1px solid var(--line)' }}>Archived</T> section in the left rail.
        </T>
      </div>

      <div style={{ padding: '8px 22px 16px' }}>
        <T kind="caption" color="var(--ink-3)" style={{ display: 'block', marginBottom: 6 }}>TYPE THE REPO NAME TO CONFIRM</T>
        <div style={{
          padding: '8px 12px', minHeight: 38,
          background: 'var(--surface)',
          border: '1.5px solid var(--danger)',
          borderRadius: 'var(--r-sm)',
          boxShadow: '0 0 0 3px var(--danger-soft)',
          display: 'flex', alignItems: 'center',
        }}>
          <T kind="mono-md" style={{ flex: 1 }}>acme-orders|</T>
          <Icon.Check size={14} style={{ color: 'var(--good)' }} />
        </div>
      </div>

      <div style={{ padding: '14px 22px', borderTop: '1px solid var(--line)', background: 'var(--paper-2)', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <Button variant="ghost" size="md">Cancel</Button>
        <Button variant="danger" size="md">Archive repo</Button>
      </div>
    </div>
  );
}

function CV2ArchiveConfirmScreen() {
  return (
    <div className="hf" style={{ width: CV2_W, height: 900, position: 'relative', overflow: 'hidden' }}>
      <HFGlobalStyles />
      <div style={{ position: 'absolute', inset: 0, transform: 'translateY(0)' }}>
        <CV2RepoScreen />
      </div>
      <CV2Dimmer intensity={0.5} />
      <div style={{ position: 'absolute', top: 140, left: '50%', transform: 'translateX(-50%)', zIndex: 7 }}>
        <CV2ArchiveConfirm />
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════
// 5) ADD-REPO DIALOG
// ═════════════════════════════════════════════════════════════
function CV2AddRepo() {
  return (
    <div style={{
      width: 620, background: 'var(--paper)',
      border: '1px solid var(--line)', borderRadius: 'var(--r-xl)',
      boxShadow: '0 24px 60px rgba(14, 14, 12, 0.32)',
      pointerEvents: 'auto', display: 'flex', flexDirection: 'column',
      overflow: 'hidden',
    }}>
      <div style={{ padding: '20px 22px 14px', borderBottom: '1px solid var(--line)' }}>
        <T kind="h2" style={{ letterSpacing: '-0.018em' }}>Register a new repo</T>
        <T kind="body-sm" color="var(--ink-3)" style={{ display: 'block', marginTop: 6, lineHeight: 1.55 }}>
          Inherits global defaults — agent, models, preambles, tag vocab. You can override per-repo settings after registration.
        </T>
      </div>

      <div style={{ padding: '18px 22px', display: 'flex', flexDirection: 'column', gap: 14 }}>
        <FocusedField label="REPO_ID" value="acme-billing|" helper="lowercase slug · used as the repos table key" />
        <CV2Field fullRow label="REPO_URL" value="git@github.com:acme/billing.git" source="repo-only" />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          <CV2Field label="BASE_BRANCH" value="main" source="repo-only" />
          <CV2Field label="PACKAGE_MANAGER" value="bun" source="repo-only" suffix={<Icon.Chevron size={11} dir="down" style={{ color: 'var(--ink-3)' }} />} />
        </div>
        <CV2Field fullRow label="INSTALL_CMD" value="bun install --frozen-lockfile" source="repo-only" hint="autofilled from package_manager" />
        <CV2Field fullRow label="TEST_CMD" value="bun test" source="repo-only" />

        <div style={{
          padding: 12, background: 'var(--accent-soft)',
          border: '1px solid var(--accent-line)', borderRadius: 'var(--r-sm)',
          display: 'flex', alignItems: 'flex-start', gap: 10,
        }}>
          <Icon.Sparkle size={14} style={{ color: 'var(--accent)', marginTop: 2, flexShrink: 0 }} />
          <div>
            <T kind="body-sm" style={{ fontWeight: 500, display: 'block', color: 'var(--accent-ink)' }}>Inherits from Global</T>
            <T kind="body-sm" color="var(--ink-2)" style={{ display: 'block', marginTop: 2, lineHeight: 1.45 }}>
              Worker: claude · opus-4-1 · Reviewer: claude · opus-4-1 · Tag vocab: type (required), priority. Add overrides after registering.
            </T>
          </div>
        </div>
      </div>

      <div style={{ padding: '14px 22px', borderTop: '1px solid var(--line)', background: 'var(--paper-2)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
        <T kind="mono-sm" color="var(--ink-3)">runs: quay repo add</T>
        <HStack gap={8}>
          <Button variant="ghost" size="md">Cancel</Button>
          <Button variant="primary" size="md">Register and clone</Button>
        </HStack>
      </div>
    </div>
  );
}

function CV2AddRepoScreen() {
  return (
    <div className="hf" style={{ width: CV2_W, height: 1000, position: 'relative', overflow: 'hidden' }}>
      <HFGlobalStyles />
      <div style={{ position: 'absolute', inset: 0 }}>
        <CV2GlobalScreen />
      </div>
      <CV2Dimmer intensity={0.45} />
      <div style={{ position: 'absolute', top: 80, left: '50%', transform: 'translateX(-50%)', zIndex: 7 }}>
        <CV2AddRepo />
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════
// 6) EMPTY STATE — fresh deployment, no repos
// ═════════════════════════════════════════════════════════════
function CV2EmptyScreen() {
  return (
    <div className="hf" style={{ width: CV2_W, height: 900, display: 'flex', flexDirection: 'column' }}>
      <HFGlobalStyles />
      <CV2TopBar scope="Global" />
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        {/* Left rail — empty repo list */}
        <div style={{
          width: 240, borderRight: '1px solid var(--line)',
          background: 'var(--paper)', padding: '16px 12px',
          display: 'flex', flexDirection: 'column', gap: 2, flexShrink: 0,
        }}>
          <T kind="caption" color="var(--ink-3)" style={{ padding: '4px 8px 6px' }}>SCOPE</T>
          <div style={{
            padding: '9px 10px', borderRadius: 'var(--r-sm)',
            background: 'var(--surface)', border: '1px solid var(--line)',
            borderLeft: '2px solid var(--accent)',
          }}>
            <HStack gap={9}>
              <Icon.Settings size={14} style={{ color: 'var(--accent)' }} />
              <div style={{ flex: 1 }}>
                <T kind="body-sm" style={{ fontWeight: 600, display: 'block' }}>Global</T>
                <T kind="mono-sm" color="var(--ink-3)" style={{ display: 'block' }}>defaults for all repos</T>
              </div>
            </HStack>
          </div>

          <HStack gap={6} style={{ padding: '18px 8px 4px' }}>
            <T kind="caption" color="var(--ink-3)">REGISTERED REPOS</T>
            <T kind="mono-sm" color="var(--ink-4)">0</T>
          </HStack>
          <div style={{
            padding: '14px 12px',
            background: 'var(--paper-2)',
            border: '1px dashed var(--line-2)',
            borderRadius: 'var(--r-sm)',
            margin: '4px 4px 0',
          }}>
            <T kind="body-sm" color="var(--ink-3)" style={{ display: 'block', lineHeight: 1.45 }}>
              No repos yet. Register one to start enqueueing tasks.
            </T>
            <Button variant="secondary" size="sm" leading={<Icon.Plus size={11} />} style={{ marginTop: 10, width: '100%', justifyContent: 'center' }}>
              Register repo
            </Button>
          </div>
        </div>

        {/* Main area */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, background: 'var(--paper-2)' }}>
          <div style={{ padding: '24px 28px 18px', borderBottom: '1px solid var(--line)', background: 'var(--paper)' }}>
            <HStack gap={12} align="baseline" style={{ marginBottom: 6 }}>
              <Icon.Settings size={18} style={{ color: 'var(--accent)' }} />
              <T kind="h1" style={{ fontSize: 26, letterSpacing: '-0.02em' }}>Welcome to Quay</T>
              <span style={{ flex: 1 }} />
              <T kind="mono-sm" color="var(--ink-3)">quay v0.1.0+abcdef1</T>
            </HStack>
            <T kind="body" color="var(--ink-3)" style={{ maxWidth: 720, lineHeight: 1.55 }}>
              Quay is configured but no repositories are registered yet. Start by registering a repo, then optionally override the defaults below.
            </T>
          </div>

          <div style={{ flex: 1, padding: '32px 28px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-start' }}>
            <Card padding={32} style={{ width: 600, textAlign: 'left' }}>
              <T kind="caption" color="var(--accent-ink)" style={{ display: 'block', marginBottom: 8 }}>STEP 1</T>
              <T kind="h2" style={{ letterSpacing: '-0.018em', display: 'block' }}>Register your first repo</T>
              <T kind="body" color="var(--ink-3)" style={{ display: 'block', marginTop: 8, lineHeight: 1.55 }}>
                Quay creates a bare clone and worktrees on demand. You'll need the repo URL, the base branch, and the install / test commands.
              </T>
              <HStack gap={10} style={{ marginTop: 16 }}>
                <Button variant="primary" leading={<Icon.Plus size={13} />}>Register repo</Button>
                <Button variant="ghost">View CLI equivalent</Button>
              </HStack>
              <Divider style={{ margin: '24px 0' }} />

              <T kind="caption" color="var(--ink-3)" style={{ display: 'block', marginBottom: 8 }}>OR EDIT GLOBAL DEFAULTS FIRST</T>
              <HStack gap={6} wrap>
                <Chip leading={<Icon.Bot size={11} />}>Default agents</Chip>
                <Chip leading={<Icon.Anchor size={11} />}>Default prompts</Chip>
                <Chip>Default tag vocab</Chip>
                <Chip>Adapters</Chip>
              </HStack>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, {
  CV2PreambleDrawerScreen,
  CV2SaveModalScreen,
  CV2FieldStates,
  CV2ArchiveConfirmScreen,
  CV2AddRepoScreen,
  CV2EmptyScreen,
});
