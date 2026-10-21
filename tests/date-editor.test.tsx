import { createRef } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it } from 'vitest';

import {
  DateCellEditor,
  formatDateTypingInput,
  type DateEditorRef,
} from '../src/features/sheet/date-editor';

describe('date typing mask (F2)', () => {
  it('masks typing 10012004 -> 10/01/2004 progressively in the grid editor', () => {
    const editorRef = createRef<DateEditorRef>();
    render(<DateCellEditor value="" ref={editorRef} />);
    const input = screen.getByLabelText('Date (DD/MM/YYYY)');

    fireEvent.change(input, { target: { value: '1' } });
    fireEvent.change(input, { target: { value: '10' } });
    expect(input).toHaveValue('10/');
    fireEvent.change(input, { target: { value: '10/0' } });
    fireEvent.change(input, { target: { value: '10/01' } });
    expect(input).toHaveValue('10/01/');
    fireEvent.change(input, { target: { value: '10/01/2' } });
    fireEvent.change(input, { target: { value: '10/01/20' } });
    fireEvent.change(input, { target: { value: '10/01/200' } });
    fireEvent.change(input, { target: { value: '10/01/2004' } });

    expect(input).toHaveValue('10/01/2004');
    // Committed value is the storage form (YYYY-MM-DD).
    expect(editorRef.current?.getValue()).toBe('2004-01-10');
  });

  it('normalizes pasted 10012004 / 10-01-2004 / 2004-01-10 to DD/MM/YYYY', () => {
    for (const [pasted, shown] of [
      ['10012004', '10/01/2004'],
      ['10-01-2004', '10/01/2004'],
      ['2004-01-10', '10/01/2004'],
    ] as const) {
      const editorRef = createRef<DateEditorRef>();
      const { unmount } = render(<DateCellEditor value="" ref={editorRef} />);
      const input = screen.getByLabelText('Date (DD/MM/YYYY)');
      fireEvent.change(input, { target: { value: pasted } });
      expect(input).toHaveValue(shown);
      expect(editorRef.current?.getValue()).toBe('2004-01-10');
      unmount();
    }
  });

  it('shows DD/MM/YYYY value from storage form on open', () => {
    render(<DateCellEditor value="2004-01-10" ref={createRef<DateEditorRef>()} />);
    expect(screen.getByLabelText('Date (DD/MM/YYYY)')).toHaveValue('10/01/2004');
  });

  it('warns and never silently changes impossible dates', () => {
    const editorRef = createRef<DateEditorRef>();
    render(<DateCellEditor value="" ref={editorRef} />);
    const input = screen.getByLabelText('Date (DD/MM/YYYY)');

    fireEvent.change(input, { target: { value: '31022004' } });
    expect(input).toHaveValue('31/02/2004');
    expect(screen.getByRole('alert')).toHaveTextContent(/kept unchanged/i);
    // The typed text is preserved on commit — no silent change.
    expect(editorRef.current?.getValue()).toBe('31/02/2004');

    // A valid complete date clears the warning again.
    fireEvent.change(input, { target: { value: '28/02/2004' } });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(editorRef.current?.getValue()).toBe('2004-02-28');
  });

  it('does not flag incomplete typing as invalid', () => {
    render(<DateCellEditor value="" ref={createRef<DateEditorRef>()} />);
    const input = screen.getByLabelText('Date (DD/MM/YYYY)');
    fireEvent.change(input, { target: { value: '10' } });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: '10/0' } });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('formatDateTypingInput keeps the mandated mask and paste rules', () => {
    expect(formatDateTypingInput('10')).toBe('10/');
    expect(formatDateTypingInput('1001')).toBe('10/01/');
    expect(formatDateTypingInput('10012004')).toBe('10/01/2004');
    expect(formatDateTypingInput('10-01-2004')).toBe('10/01/2004');
    expect(formatDateTypingInput('2004-01-10')).toBe('10/01/2004');
    expect(formatDateTypingInput('31022004')).toBe('31/02/2004'); // kept, warned elsewhere
  });
});
