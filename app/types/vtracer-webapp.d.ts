declare module "vtracer-webapp/vtracer_webapp_bg.js" {
  export function __wbg_set_wasm(exports: WebAssembly.Exports): void;
  export class BinaryImageConverter {
    static new_with_string(params: string): BinaryImageConverter;
    init(): void;
    tick(): boolean;
    progress(): number;
    free(): void;
  }
}

declare module "vtracer-webapp/vtracer_webapp_bg.wasm?url" {
  const url: string;
  export default url;
}
