declare module 'sql.js' {
  export interface Statement {
    bind(params?: any[]): boolean;
    step(): boolean;
    getAsObject(): any;
    free(): boolean;
  }

  export class Database {
    constructor(data?: ArrayLike<number>);
    run(sql: string, params?: any[]): Database;
    exec(sql: string): { columns: string[]; values: any[][] }[];
    prepare(sql: string): Statement;
    export(): Uint8Array;
    close(): void;
  }

  export interface SqlJsStatic {
    Database: typeof Database;
  }

  export default function initSqlJs(config?: { locateFile?: (file: string) => string }): Promise<SqlJsStatic>;
}
