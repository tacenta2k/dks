import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { beforeEach, describe, expect, it } from 'vitest';

import { App } from '../src/renderer/App';

describe('DKS renderer shell', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('shows the login placeholder before a session is available', () => {
    render(<App />);

    expect(screen.getByRole('heading', { name: 'Sign in to DKS' })).toBeInTheDocument();
    expect(screen.getByText(/authentication will be connected in step 2/i)).toBeInTheDocument();
  });

  it('renders the dashboard shell when the placeholder login is continued', () => {
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: /continue to workspace/i }));

    expect(screen.getByRole('banner', { name: 'DKS top bar' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Primary navigation' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
    expect(screen.getByText('Your workspace is ready for the next step.')).toBeInTheDocument();
  });

  it('switches between dashboard and sheet placeholders from the sidebar', () => {
    render(<App initialView="dashboard" startInWorkspace />);
    fireEvent.click(screen.getByRole('button', { name: 'Open Sheet' }));

    expect(screen.getByRole('heading', { name: 'Visa sheet' })).toBeInTheDocument();
    expect(screen.getByText('Your visa records will appear here in STEP 4.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open Dashboard' })).toHaveAttribute('aria-current', 'false');
  });

  it('changes and persists the selected theme from the top bar', () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /continue to workspace/i }));

    fireEvent.click(screen.getByRole('button', { name: /theme: system/i }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Dark' }));

    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    expect(window.localStorage.getItem('dks.theme-preference')).toBe('dark');
  });
});
