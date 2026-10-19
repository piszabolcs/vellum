import { useState } from 'react';
import { useT } from '../i18n';

interface Props {
  disabled: boolean;
  onSend: (text: string) => void;
}

export default function InputBox({ disabled, onSend }: Props) {
  const [text, setText] = useState('');
  const t = useT();

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setText('');
  };

  return (
    <div className="px-5 pb-2 pt-1">
      <div className="glass-card flex items-end gap-1.5 px-3 py-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          rows={2}
          aria-label={t('input.placeholder')}
          placeholder={t('input.placeholder')}
          className="max-h-24 flex-1 resize-none bg-transparent text-[13px] leading-relaxed
                     text-text-primary placeholder:text-text-secondary/50 focus:outline-none"
        />
        <button
          onClick={submit}
          disabled={disabled || text.trim() === ''}
          title={t('input.send')}
          aria-label={t('input.send')}
          style={{
            backgroundImage:
              'linear-gradient(to bottom right, rgb(var(--vellum-bronze-light-rgb)), rgb(var(--vellum-bronze-rgb)))'
          }}
          className="mb-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl
                     text-white
                     transition-transform hover:scale-105 active:scale-95
                     disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:scale-100"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m22 2-7 20-4-9-9-4z" />
            <path d="M22 2 11 13" />
          </svg>
        </button>
      </div>
    </div>
  );
}
