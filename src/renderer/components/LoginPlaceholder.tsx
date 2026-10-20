import { AuthScreen, type AuthScreenProps } from '../../features/auth/AuthScreen';
import { isSupabaseConfigured } from '../../lib/supabase';

export interface LoginPlaceholderProps extends AuthScreenProps {
  /** Retained for STEP 1 callers; it is only rendered when demo mode is enabled. */
  onContinue?: () => void;
}

export function LoginPlaceholder({ onContinue, onDemoContinue, demoAvailable, ...props }: LoginPlaceholderProps) {
  const safeDevelopmentDemo =
    !isSupabaseConfigured() && (import.meta.env.DEV || import.meta.env.MODE === 'test');
  const requestedDemo = demoAvailable ?? Boolean(onContinue ?? onDemoContinue);

  return (
    <AuthScreen
      {...props}
      demoAvailable={safeDevelopmentDemo && requestedDemo}
      onDemoContinue={onDemoContinue ?? onContinue}
    />
  );
}
