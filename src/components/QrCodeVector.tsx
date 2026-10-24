import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';

interface QrCodeVectorProps {
  url: string;
  size?: number;
  onSvgReady?: (svgMarkup: string) => void;
}

export const QrCodeVector: React.FC<QrCodeVectorProps> = ({
  url,
  size = 180,
  onSvgReady,
}) => {
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
          onSvgReady?.(svg);
        }
      }
    );
    return () => {
      active = false;
    };
  }, [url, size, onSvgReady]);

  if (!svgMarkup) {
    return (
      <div className="w-[204px] h-[204px] flex items-center justify-center rounded-xl border border-stone-200 bg-stone-50 p-2.5 text-xs font-mono text-stone-400">
        QR...
      </div>
    );
  }

  return (
    <div
      className="w-[204px] h-[204px] inline-block overflow-hidden rounded-xl border border-stone-200 bg-white p-2.5 shadow-xs"
      dangerouslySetInnerHTML={{ __html: svgMarkup }}
    />
  );
};
