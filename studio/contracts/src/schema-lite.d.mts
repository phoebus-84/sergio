export interface SchemaProblem {
  code: string;
  path: string;
  message: string;
}

/** Problems of `value` under `schema` (a part of draft 2020-12; `$ref`s resolve in `root`). */
export declare function check(root: object, schema: object | true, value: unknown, path?: string): SchemaProblem[];
