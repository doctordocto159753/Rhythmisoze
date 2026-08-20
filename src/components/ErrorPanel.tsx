'use client';

import type { AppError, AppErrorCode, RecoveryAction } from '@contracts';
import { useMessages } from '@/i18n/provider';
import { Button } from './Button';
import { Stack, Row, Well } from './Layout';
import { Text } from './Text';

export interface ErrorPanelProps {
  error: Pick<AppError, 'code' | 'recovery'>;
  onRecover?(action: RecoveryAction): void;
  onDismiss?(): void;
}

/**
 * The single error presentation.
 *
 * Two rules the copy rules force (Playbook 11: "explain errors through the next
 * action the user can take"):
 *  1. Every code has a localized sentence. There is no code path that shows a
 *     stack, an exception name or an English string in a Persian UI.
 *  2. The recovery action is a real button that does the thing, not advice.
 *
 * `role="alert"` rather than a polite region: an error interrupts the user's
 * task and they need to know now.
 */
export function ErrorPanel({ error, onRecover, onDismiss }: ErrorPanelProps) {
  const t = useMessages();
  const message = t.errors[error.code as AppErrorCode] ?? t.errors.unknown;
  const hint = (t.errors.hints as Partial<Record<AppErrorCode, string>>)[error.code];
  const recoveryLabel = t.errors.recovery[error.recovery];

  return (
    <Well tone="danger" role="alert" as="section">
      <Stack gap={3}>
        <Text variant="heading" as="h3">
          {t.errors.title}
        </Text>
        <Text>{message}</Text>
        {hint ? (
          <Text variant="micro" muted>
            {hint}
          </Text>
        ) : null}
        <Row gap={2}>
          {error.recovery !== 'none' && onRecover ? (
            <Button kind="primary" onClick={() => onRecover(error.recovery)}>
              {recoveryLabel}
            </Button>
          ) : null}
          {onDismiss ? (
            <Button kind="ghost" onClick={onDismiss}>
              {t.common.close}
            </Button>
          ) : null}
        </Row>
      </Stack>
    </Well>
  );
}
