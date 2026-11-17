import { verifyPin } from '@medflow/core';
import { useEffect, useRef, useState } from 'react';
import type { Staff } from '../backend/types.ts';

/** A PIN box with an on-screen keypad (touch screens) that also takes the keyboard. Checks the PIN on this PC. */
export function PinPad(props: {
  staff: Staff;
  title: string;
  wrongText: string;
  submitText: string;
  onOk: () => void | Promise<void>;
  onWrong?: () => void | Promise<void>;
}) {
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); setPin(''); setError(null); }, [props.staff.id]);

  const locked = props.staff.locked_until && Date.parse(props.staff.locked_until) > Date.now();
  const submit = async (value = pin) => {
    if (busy || value.length < 4) return;
    setBusy(true);
    setError(null);
    try {
      if (await verifyPin(value, props.staff.pin_hash)) {
        await props.onOk();
      } else {
        setError(props.wrongText);
        setPin('');
        await props.onWrong?.();
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      input.current?.focus();
    }
  };
  const press = (d: string) => {
    const next = (pin + d).slice(0, 6);
    setPin(next);
  };

  return (
    <div className="pinpad">
      <div className="pinpad-title">{props.title}</div>
      <input
        ref={input}
        className="pin-input"
        type="password"
        inputMode="numeric"
        autoComplete="off"
        maxLength={6}
        value={pin}
        disabled={!!locked || busy}
        onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
        onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
        aria-label={props.title}
      />
      {locked && <div className="form-error">Locked until {new Date(props.staff.locked_until!).toLocaleTimeString()}</div>}
      {error && <div className="form-error">{error}</div>}
      <div className="keys">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
          <button key={d} type="button" className="key" onClick={() => press(d)} disabled={!!locked || busy}>{d}</button>
        ))}
        <button type="button" className="key muted-key" onClick={() => setPin(pin.slice(0, -1))} disabled={busy}>⌫</button>
        <button type="button" className="key" onClick={() => press('0')} disabled={!!locked || busy}>0</button>
        <button type="button" className="key ok-key" onClick={() => void submit()} disabled={!!locked || busy || pin.length < 4}>
          {busy ? '…' : props.submitText}
        </button>
      </div>
    </div>
  );
}
