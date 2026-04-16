import { useCallback, useRef, type CSSProperties } from 'react';
import Form from '@rjsf/core';
import type { IChangeEvent, RJSFSchema, UiSchema } from '@rjsf/utils';
import validator from '@rjsf/validator-ajv8';
import type { CustomStencilDefinition } from '../../ai/customStencil';
import { unregisterStencil } from '../../ai/customStencilStore';

// ---------------------------------------------------------------------------
// Styles (matching GodMode sidebar conventions)
// ---------------------------------------------------------------------------

const fieldStackStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
};

const mutedTextStyle: CSSProperties = {
  fontSize: 13,
  color: 'rgba(238, 247, 255, 0.6)',
};

const baseButtonStyle: CSSProperties = {
  borderRadius: 10,
  padding: '10px 12px',
  border: '1px solid rgba(167, 208, 237, 0.16)',
  cursor: 'pointer',
  fontWeight: 600,
};

const dangerButtonStyle: CSSProperties = {
  ...baseButtonStyle,
  background: '#ff8573',
  color: '#38130e',
  fontSize: 13,
};

// Minimal dark-theme overrides for rjsf form elements
const formContainerStyle: CSSProperties = {
  fontSize: 13,
  color: 'rgba(238, 247, 255, 0.82)',
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CustomStencilPanel({
  stencil,
  params,
  onChange,
}: {
  stencil: CustomStencilDefinition;
  params: Record<string, unknown>;
  onChange: (nextParams: Record<string, unknown>) => void;
}) {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const handleFormChange = useCallback((event: IChangeEvent) => {
    if (event.formData !== undefined) {
      onChangeRef.current(event.formData as Record<string, unknown>);
    }
  }, []);

  const handleRemove = useCallback(() => {
    unregisterStencil(stencil.id);
  }, [stencil.id]);

  const hasSchema = stencil.parameterSchema
    && typeof stencil.parameterSchema === 'object'
    && Object.keys(stencil.parameterSchema).length > 0;

  return (
    <div style={fieldStackStyle}>
      {stencil.description && (
        <div style={mutedTextStyle}>{stencil.description}</div>
      )}

      {hasSchema && (
        <div style={formContainerStyle} className="custom-stencil-form">
          <Form
            schema={stencil.parameterSchema as RJSFSchema}
            uiSchema={{
              'ui:submitButtonOptions': { norender: true },
              ...(stencil.uiSchema as UiSchema | undefined),
            }}
            formData={params}
            onChange={handleFormChange}
            validator={validator}
            liveValidate={false}
          />
        </div>
      )}

      {!hasSchema && (
        <div style={mutedTextStyle}>
          This stencil has no configurable parameters. Click and drag on terrain to apply.
        </div>
      )}

      <div style={mutedTextStyle}>
        Hold and drag to apply. The preview shows what will change.
      </div>

      <button type="button" style={dangerButtonStyle} onClick={handleRemove}>
        Remove Stencil
      </button>
    </div>
  );
}
