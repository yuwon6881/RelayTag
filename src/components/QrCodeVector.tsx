import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';

interface QrCodeVectorProps {
  url: string;
  size?: number;
}

export const QrCodeVector: React.FC<QrCodeVectorProps> = ({ url, size = 180 }) => {
  const [svgMarkup, setSvgMarkup] = useState<string>('');

  useEffect(() => {
    let active = true;
    QRCode.toString(
      url,
      {
        type: 'svg',
        margin: 1,
        width: size,
        color: {
          dark: '#141413',
          light: '#FFFFFF',
        },
        errorCorrectionLevel: 'M',
      },
      (err, svg) => {
        if (!err && active) {
          setSvgMarkup(svg);
        }
      }
    );
    return () => {
      active = false;
    };
  }, [url, size]);

  if (!svgMarkup) {
    return (
      <div
        style={{ width: size, height: size }}
        className="flex items-center justify-center rounded-xl border border-stone-200 bg-stone-50 text-xs font-mono text-stone-400"
      >
        QR...
      </div>
    );
  }

  return (
    <div
      className="inline-block overflow-hidden rounded-xl border border-stone-200 bg-white p-2.5 shadow-xs"
      style={{ width: size + 20, height: size + 20 }}
      dangerouslySetInnerHTML={{ __html: svgMarkup }}
    />
  );
};
