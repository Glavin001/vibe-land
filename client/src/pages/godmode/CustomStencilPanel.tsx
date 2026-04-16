import { useCallback, useRef, type CSSProperties, type ComponentType } from 'react';
import Form from '@rjsf/core';
import type { IChangeEvent } from '@rjsf/core';
import type { RJSFSchema, UiSchema, WidgetProps } from '@rjsf/utils';
import validator from '@rjsf/validator-ajv8';
import type { CustomStencilDefinition } from '../../ai/customStencil';
import { unregisterStencil } from '../../ai/customStencilStore';

// ---------------------------------------------------------------------------
// Custom Widgets
// ---------------------------------------------------------------------------

const sliderContainerStyle: CSSProperties = {
  display: 'flex',
  gap: 10,
  alignItems: 'center',
};

const numberInputStyle: CSSProperties = {
  width: 70,
  padding: '6px 8px',
  borderRadius: 6,
  border: '1px solid rgba(167, 208, 237, 0.3)',
  background: 'rgba(30, 40, 50, 0.8)',
  color: 'rgba(238, 247, 255, 0.9)',
  fontSize: 12,
  fontFamily: 'monospace',
  textAlign: 'center',
  transition: 'border-color 0.2s',
};

const CustomSliderNumberWidget = (props: WidgetProps) => {
  const { value, onChange, schema } = props;
  const min = typeof schema.minimum !== 'undefined' ? schema.minimum : 0;
  const max = typeof schema.maximum !== 'undefined' ? schema.maximum : 100;
  const step = typeof schema.multipleOf !== 'undefined' ? schema.multipleOf : 0.1;

  const handleSliderChange = (e: { target: { value: string } }) => {
    onChange(Number(e.target.value));
  };

  const handleInputChange = (e: { target: { value: string } }) => {
    const newVal = parseFloat(e.target.value);
    if (!isNaN(newVal)) {
      onChange(Math.max(min, Math.min(max, newVal)));
    }
  };

  return (
    <div style={sliderContainerStyle}>
      <style>{`
        .stencil-range-slider {
          flex: 1;
          height: 6px;
          border-radius: 3px;
          outline: none;
          cursor: pointer;
          -webkit-appearance: none;
          appearance: none;
          background: linear-gradient(to right, rgba(100, 150, 200, 0.3), rgba(100, 150, 200, 0.5));
          transition: box-shadow 0.2s ease;
        }
        .stencil-range-slider:hover {
          box-shadow: 0 0 8px rgba(100, 150, 200, 0.4);
        }
        .stencil-range-slider::-webkit-slider-thumb {
          -webkit-appearance: none;
          appearance: none;
          width: 16px;
          height: 16px;
          border-radius: 50%;
          background: linear-gradient(135deg, #a7d0ed 0%, #8ab5d9 100%);
          border: 2px solid rgba(167, 208, 237, 0.5);
          cursor: pointer;
          box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3);
          transition: all 0.2s ease;
        }
        .stencil-range-slider::-webkit-slider-thumb:hover {
          background: linear-gradient(135deg, #c0ddf5 0%, #a7d0ed 100%);
          border-color: rgba(167, 208, 237, 0.8);
          box-shadow: 0 4px 10px rgba(167, 208, 237, 0.3);
        }
        .stencil-range-slider::-moz-range-thumb {
          width: 16px;
          height: 16px;
          border-radius: 50%;
          background: linear-gradient(135deg, #a7d0ed 0%, #8ab5d9 100%);
          border: 2px solid rgba(167, 208, 237, 0.5);
          cursor: pointer;
          box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3);
          transition: all 0.2s ease;
        }
        .stencil-range-slider::-moz-range-thumb:hover {
          background: linear-gradient(135deg, #c0ddf5 0%, #a7d0ed 100%);
          border-color: rgba(167, 208, 237, 0.8);
          box-shadow: 0 4px 10px rgba(167, 208, 237, 0.3);
        }
      `}</style>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value ?? min}
        onChange={handleSliderChange}
        className="stencil-range-slider"
      />
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value ?? ''}
        onChange={handleInputChange}
        style={numberInputStyle}
      />
    </div>
  );
};

// Custom text input widget with better styling
const CustomTextWidget = (props: WidgetProps) => {
  const { value, onChange } = props;

  const handleChange = (e: { target: { value: string } }) => {
    onChange(e.target.value || undefined);
  };

  return (
    <input
      type="text"
      value={value ?? ''}
      onChange={handleChange}
      style={{
        width: '100%',
        padding: '8px 10px',
        borderRadius: 6,
        border: '1px solid rgba(167, 208, 237, 0.3)',
        background: 'rgba(30, 40, 50, 0.8)',
        color: 'rgba(238, 247, 255, 0.9)',
        fontSize: 12,
        fontFamily: 'monospace',
        transition: 'border-color 0.2s, background-color 0.2s',
      }}
      onFocus={(e) => {
        e.currentTarget.style.borderColor = 'rgba(167, 208, 237, 0.6)';
        e.currentTarget.style.background = 'rgba(30, 40, 50, 1)';
      }}
      onBlur={(e) => {
        e.currentTarget.style.borderColor = 'rgba(167, 208, 237, 0.3)';
        e.currentTarget.style.background = 'rgba(30, 40, 50, 0.8)';
      }}
    />
  );
};

// ---------------------------------------------------------------------------
// Styles (matching GodMode sidebar conventions)
// ---------------------------------------------------------------------------

const containerStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
};

const descriptionStyle: CSSProperties = {
  fontSize: 13,
  color: 'rgba(238, 247, 255, 0.7)',
  lineHeight: 1.5,
  padding: '10px 0',
  borderBottom: '1px solid rgba(167, 208, 237, 0.1)',
};

const formFieldStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
};

const fieldLabelStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: 'rgba(238, 247, 255, 0.85)',
  textTransform: 'uppercase',
  letterSpacing: 0.5,
};

const fieldHintStyle: CSSProperties = {
  fontSize: 11,
  color: 'rgba(238, 247, 255, 0.5)',
  fontStyle: 'italic',
};

const helpTextStyle: CSSProperties = {
  fontSize: 12,
  color: 'rgba(238, 247, 255, 0.6)',
  lineHeight: 1.4,
  padding: '8px 0',
};

const baseButtonStyle: CSSProperties = {
  borderRadius: 8,
  padding: '10px 14px',
  border: '1px solid rgba(167, 208, 237, 0.16)',
  cursor: 'pointer',
  fontWeight: 600,
  fontSize: 12,
  transition: 'all 0.2s ease',
  fontFamily: 'monospace',
};

const dangerButtonStyle: CSSProperties = {
  ...baseButtonStyle,
  background: 'linear-gradient(135deg, #ff8573 0%, #ff7060 100%)',
  color: '#fff',
  border: '1px solid #ff6a4f',
  boxShadow: '0 4px 12px rgba(255, 133, 115, 0.2)',
};

// Custom form wrapper to style rjsf elements
const formWrapperStyle: CSSProperties = {
  fontSize: 13,
  color: 'rgba(238, 247, 255, 0.82)',
};

// ---------------------------------------------------------------------------
// Custom Form Template
// ---------------------------------------------------------------------------

const CustomFieldTemplate = (props: any) => {
  const { classNames, label, help, required, children, description } = props;

  return (
    <div style={formFieldStyle} className={classNames}>
      {label && (
        <label style={fieldLabelStyle}>
          {label}
          {required && <span style={{ color: '#ff8573' }}>*</span>}
        </label>
      )}
      {description && (
        <div style={fieldHintStyle}>{description}</div>
      )}
      {children}
      {help && <div style={fieldHintStyle}>{help}</div>}
    </div>
  );
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

  const widgets = {
    SliderNumberWidget: CustomSliderNumberWidget,
    text: CustomTextWidget,
  } as Record<string, ComponentType<WidgetProps>>;

  return (
    <div style={containerStyle}>
      {stencil.description && (
        <div style={descriptionStyle}>{stencil.description}</div>
      )}

      {hasSchema && (
        <div style={formWrapperStyle} className="custom-stencil-form">
          <style>{`
            .custom-stencil-form fieldset {
              border-color: transparent;
            }
          `}</style>
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
            widgets={widgets}
            templates={{ FieldTemplate: CustomFieldTemplate }}
          />
        </div>
      )}

      {!hasSchema && (
        <div style={helpTextStyle}>
          This stencil has no configurable parameters. Click and drag on terrain to apply.
        </div>
      )}

      <div style={helpTextStyle}>
        💡 Hold and drag to apply. The preview shows what will change.
      </div>

      <button
        type="button"
        style={dangerButtonStyle}
        onClick={handleRemove}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = 'linear-gradient(135deg, #ff7060 0%, #ff5a47 100%)';
          e.currentTarget.style.boxShadow = '0 6px 16px rgba(255, 133, 115, 0.3)';
          e.currentTarget.style.transform = 'translateY(-1px)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'linear-gradient(135deg, #ff8573 0%, #ff7060 100%)';
          e.currentTarget.style.boxShadow = '0 4px 12px rgba(255, 133, 115, 0.2)';
          e.currentTarget.style.transform = 'translateY(0)';
        }}
      >
        Remove Stencil
      </button>
    </div>
  );
}
