declare module "qrcode-terminal" {
  const qrcode: { generate(text: string, opts?: { small?: boolean }, cb?: (out: string) => void): void };
  export default qrcode;
}
