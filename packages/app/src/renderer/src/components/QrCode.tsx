import QRCode from 'qrcode';
import { useMemo } from 'react';

/** Renderiza o QR code em SVG puro via React para respeitar a CSP restritiva do renderer (sem `data:`). */
export function QrCode({
  value,
  size = 180,
  margin = 2,
  label = 'QR code para parear o celular',
  testId,
}: {
  value: string;
  size?: number;
  margin?: number;
  label?: string;
  testId?: string;
}) {
  const { total, path } = useMemo(() => {
    const { modules } = QRCode.create(value, { errorCorrectionLevel: 'M' });
    const parts: string[] = [];
    for (let r = 0; r < modules.size; r++) {
      for (let c = 0; c < modules.size; c++) {
        if (modules.get(r, c)) {
          parts.push(`M${c + margin} ${r + margin}h1v1h-1z`);
        }
      }
    }
    return {
      total: modules.size + margin * 2,
      path: parts.join(''),
    };
  }, [value, margin]);

  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${total} ${total}`}
      width={size}
      height={size}
      shapeRendering="crispEdges"
      data-testid={testId}
    >
      <rect width={total} height={total} fill="#ffffff" />
      {path ? <path d={path} fill="#000000" /> : null}
    </svg>
  );
}
