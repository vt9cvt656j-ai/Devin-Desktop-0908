/// <reference types="vite/client" />

/** 构建时间戳，vite.config.ts 的 define 注入；用途见那里的说明（让每次构建的哈希都变）。 */
declare const __SITE_BUILD__: string;
