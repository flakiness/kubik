export type RawConfigOptions = {
  name?: string,
  watch?: string | string[],
  ignore?: string | string[],
  deps?: string | string[],
}

export class Kubik {
  static buildTask(options: RawConfigOptions) {
    if (process.env.KUBIK_DUMP_CONFIGURATION) {
      console.log(JSON.stringify(options));
      process.exit(0);
    }
  }
}
