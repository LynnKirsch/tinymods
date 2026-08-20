declare module "heic2any" {
  type HeicConversionOptions = {
    blob: Blob;
    toType?: "image/jpeg" | "image/png" | "image/gif";
    quality?: number;
    multiple?: boolean;
  };

  export default function heic2any(
    options: HeicConversionOptions,
  ): Promise<Blob | Blob[]>;
}
