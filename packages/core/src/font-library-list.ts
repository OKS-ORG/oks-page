// The fonts of the built-in library (ADR 0028). Written by scripts/build-font-library.mjs; do not edit by hand.
// Every font is under the SIL Open Font Licence 1.1, taken from a pinned Fontsource package whose fingerprint
// (`integrity`) was compared with the registry's when it was downloaded. Each file is named by its own SHA-256.
import type { LibraryFont } from "./font-library.js";

export const FONT_LIBRARY_LIST: readonly LibraryFont[] = [
  {
    key: "inter",
    name: "Inter",
    kind: "sans",
    scripts: ["latin"],
    package: "@fontsource/inter",
    version: "5.3.0",
    integrity:
      "sha512-RofMylZmjlJEfELXeNHFWBRcSs75rGU/6bV2S2jfnvv/3rPXPGe0LgUJTklcHZ9lM4OZmAVFhcJPnACfb91A3g==",
    license: "OFL-1.1",
    copyright: "Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter)",
    files: [
      {
        script: "latin",
        weight: 400,
        sha256: "8909904ab6c872eb994093482a88a28eca2cd95912d7b6fecd72103b0dc07edc",
        bytes: 23664,
      },
      {
        script: "latin",
        weight: 700,
        sha256: "6f56409fd3d64bb85f7d070bce20749db2d66b6d63cec586cc22d1c761be2491",
        bytes: 24356,
      },
    ],
  },
  {
    key: "roboto",
    name: "Roboto",
    kind: "sans",
    scripts: ["latin"],
    package: "@fontsource/roboto",
    version: "5.3.0",
    integrity:
      "sha512-BapRJOWYP+LZ21zp+wBQjfpPYKRoxc4LspJ/RLuI+HSMBD5u/X4O+ESDrSvEqDSy0rAl7GwBJ+09mdc16cVQ1Q==",
    license: "OFL-1.1",
    copyright:
      "Copyright 2011 The Roboto Project Authors (https://github.com/googlefonts/roboto-classic)",
    files: [
      {
        script: "latin",
        weight: 400,
        sha256: "425c0713a8176f92273d378599c7eac57de7fafabd4bd0ed457b70eb8f80d371",
        bytes: 21884,
      },
      {
        script: "latin",
        weight: 700,
        sha256: "b9d66d1708156f765ada51939bc24ed259dafa69eb631b36e443680fe9e15879",
        bytes: 22240,
      },
    ],
  },
  {
    key: "open-sans",
    name: "Open Sans",
    kind: "sans",
    scripts: ["latin"],
    package: "@fontsource/open-sans",
    version: "5.3.0",
    integrity:
      "sha512-V1bdMlGNyZrJwzrdusshMOw2YR0aqYDL7kOo9dkxUEKl8dFv66A9HLckOOXl572sG/7ohhDQrCrTFGSn9LZcSw==",
    license: "OFL-1.1",
    copyright:
      "Copyright 2020 The Open Sans Project Authors (https://github.com/googlefonts/opensans)",
    files: [
      {
        script: "latin",
        weight: 400,
        sha256: "0e44026ad31376af1b56593cd4acb4f353f8e8789c51759e18f64578e4ef296a",
        bytes: 18640,
      },
      {
        script: "latin",
        weight: 700,
        sha256: "594a622208d1dad5d1dd58aef74f212ce7132d8f0aa5bacea6cfeb86d308c17a",
        bytes: 18204,
      },
    ],
  },
  {
    key: "montserrat",
    name: "Montserrat",
    kind: "sans",
    scripts: ["latin"],
    package: "@fontsource/montserrat",
    version: "5.3.0",
    integrity:
      "sha512-iQPDtZOnmM5ih4JBGaMSXisRap0ixb9bAUw2hDtY7EjVfaqiiNlKtVuJl9XclxUwtwMMHNcWXfQR6zI9x05+Tg==",
    license: "OFL-1.1",
    copyright:
      "Copyright 2011 The Montserrat Project Authors (https://github.com/JulietaUla/Montserrat)",
    files: [
      {
        script: "latin",
        weight: 400,
        sha256: "e66bcd2761ab6924b25ce70dafe10e57a39193c4fea1516730bd9cb5240af6c8",
        bytes: 18780,
      },
      {
        script: "latin",
        weight: 700,
        sha256: "f9d9e65b15372cebcafc3acd1e664a564c5c4b23278de4d5760de9a13c530371",
        bytes: 18824,
      },
    ],
  },
  {
    key: "poppins",
    name: "Poppins",
    kind: "sans",
    scripts: ["latin", "devanagari"],
    package: "@fontsource/poppins",
    version: "5.3.0",
    integrity:
      "sha512-cms1nM7U6SN8epIV1WMVOV8VsA645aSm3wHfzIQnkk188U341ThbJGSl2Sv54V29gnDbT2arMPfLzvVIIVCceQ==",
    license: "OFL-1.1",
    copyright: "Copyright 2020 The Poppins Project Authors (https://github.com/itfoundry/Poppins)",
    files: [
      {
        script: "devanagari",
        weight: 400,
        sha256: "6b986471df6084ba6f89749100b2731200a722d3de0e00f48e1967f21eb2adc0",
        bytes: 39660,
      },
      {
        script: "devanagari",
        weight: 700,
        sha256: "de10eb6f1f452594080f69e1e4925fc68f2d594b4837c70b6c8e6ac0e8384916",
        bytes: 39252,
      },
      {
        script: "latin",
        weight: 400,
        sha256: "7d93459d86585bfcdbb7e0376056226adb25821ee54b96236fe2123e9560929f",
        bytes: 7884,
      },
      {
        script: "latin",
        weight: 700,
        sha256: "9338e65fc077355c7a87ae0d64cc101e23b9bf8ad78ae65f0f319c857311b526",
        bytes: 7816,
      },
    ],
  },
  {
    key: "dm-sans",
    name: "DM Sans",
    kind: "sans",
    scripts: ["latin"],
    package: "@fontsource/dm-sans",
    version: "5.3.0",
    integrity:
      "sha512-lYJtMXXO28q1z+yz+z8XKd0s4hXaa9QdkETzkyD760sidCv5heI86weYA0sx0Nc4pAMAQTUuyf4gO44cYKKS9g==",
    license: "OFL-1.1",
    copyright:
      "Copyright 2014 The DM Sans Project Authors (https://github.com/googlefonts/dm-fonts)",
    files: [
      {
        script: "latin",
        weight: 400,
        sha256: "4ab51eb2cd7305d177187908d6397474d4520663f6c6e572feb0a64f4fa80006",
        bytes: 14200,
      },
      {
        script: "latin",
        weight: 700,
        sha256: "35c5efa0e5daa52ee5c6500f5be354bf751fb65c4e49e1d6806c6eb5883e8fe9",
        bytes: 14348,
      },
    ],
  },
  {
    key: "hind",
    name: "Hind",
    kind: "sans",
    scripts: ["latin", "devanagari"],
    package: "@fontsource/hind",
    version: "5.3.0",
    integrity:
      "sha512-tN9N0AurZa2N8JakQw8Eqs5/1Rzpw7J6YA1mYpkkHZ3iTw1JjbSHq6V6hGjhRdZlUMHk1sN+jOhPmuF+RkRKEg==",
    license: "OFL-1.1",
    copyright: "Copyright (c) 2014 Indian Type Foundry (info@indiantypefoundry.com)",
    files: [
      {
        script: "devanagari",
        weight: 400,
        sha256: "6939ca4cd32f9ec67af18f76e054dd63d9de0a4fafac9f0aca1e1bf652257aa8",
        bytes: 74936,
      },
      {
        script: "devanagari",
        weight: 700,
        sha256: "30b5ca4fdc95c2bfd2b806a700c59bbda959333035edd73285f0617264c45455",
        bytes: 70428,
      },
      {
        script: "latin",
        weight: 400,
        sha256: "aca5dec430a7470ff1d8a16f9e7bb3ca30f2ff58f3bd60432cf1dddfa30c9d71",
        bytes: 16216,
      },
      {
        script: "latin",
        weight: 700,
        sha256: "5aed4a8f357d7edc1ac50eb4de07867c83e69a10a1711e10053bddce99294b7e",
        bytes: 16268,
      },
    ],
  },
  {
    key: "noto-sans-devanagari",
    name: "Noto Sans Devanagari",
    kind: "sans",
    scripts: ["latin", "devanagari"],
    package: "@fontsource/noto-sans-devanagari",
    version: "5.3.0",
    integrity:
      "sha512-7khYmipS/5KAUUmrO1DKir8yL8XI00d0+ZE9BqbS8XF1jzObv6CpPOk3UeYxF+Pvi8bx9bBvprBCOcbx/eQWTQ==",
    license: "OFL-1.1",
    copyright: "Copyright 2022 The Noto Project Authors (https://github.com/notofonts/devanagari)",
    files: [
      {
        script: "devanagari",
        weight: 400,
        sha256: "f86f14cbd1004f5795689ee9cc70d5d87d915f5135b30283525c1c7b8f0eb192",
        bytes: 50416,
      },
      {
        script: "devanagari",
        weight: 700,
        sha256: "6a68069c959d7f3c02f4062dd9be85327448b5d753e95455b1c0320f37f68fc1",
        bytes: 53984,
      },
      {
        script: "latin",
        weight: 400,
        sha256: "1ea6a2f05ad1e2218d23fc9a788bcbce03c1a83e33eeb7078354ebe5f5e8d4e7",
        bytes: 10512,
      },
      {
        script: "latin",
        weight: 700,
        sha256: "9a66b62e21bcffd97e49f8cfc3630a08e70c3295e1f41f13214847281efbc252",
        bytes: 10604,
      },
    ],
  },
  {
    key: "source-serif-4",
    name: "Source Serif 4",
    kind: "serif",
    scripts: ["latin"],
    package: "@fontsource/source-serif-4",
    version: "5.3.1",
    integrity:
      "sha512-cWcTCXjYYrgF9A67fThVir1VSc0lPEYmwQ6jA4pPt01s2MSCi/maINUcZoCzaqnU8fyUReDO97eGcBUkHgOeug==",
    license: "OFL-1.1",
    copyright: "Google Inc.",
    files: [
      {
        script: "latin",
        weight: 400,
        sha256: "02194deb92d3975dd30e11a3824a1f1db32b48c93654e60560cb81ce8e7b5f95",
        bytes: 20088,
      },
      {
        script: "latin",
        weight: 700,
        sha256: "7691c51bc286a9014db0048277d2c3f2ad0a90b533dc8adfb16cb22a95390d39",
        bytes: 21716,
      },
    ],
  },
  {
    key: "eb-garamond",
    name: "EB Garamond",
    kind: "serif",
    scripts: ["latin"],
    package: "@fontsource/eb-garamond",
    version: "5.3.0",
    integrity:
      "sha512-VplwHpB8FLuzl+4G5LDci1b3Z4SghiuXH8XEgaxjnOb5aue5mEt1njmDKeO6iyLeGa73LffU7PC7hzncLRx0ZA==",
    license: "OFL-1.1",
    copyright:
      "Copyright 2017 The EB Garamond Project Authors (https://github.com/octaviopardo/EBGaramond12)",
    files: [
      {
        script: "latin",
        weight: 400,
        sha256: "912929dba0faab5e151849ea5e988adba3080ad6d2bcc4dbff27aa427896498d",
        bytes: 23820,
      },
      {
        script: "latin",
        weight: 700,
        sha256: "ae7cef029eea959654a474fbcaa2c202f205abfca29caaef62e9a0019c3c8370",
        bytes: 25292,
      },
    ],
  },
  {
    key: "noto-serif-devanagari",
    name: "Noto Serif Devanagari",
    kind: "serif",
    scripts: ["latin", "devanagari"],
    package: "@fontsource/noto-serif-devanagari",
    version: "5.3.0",
    integrity:
      "sha512-POketgM+TcAbtQCpl5GUmlCVvV7zGnFmLlQTIVxp0ePZkKTJ1UhpeyscIpgljOzHjrVzXPj7x1lSXl2W/wI3Gg==",
    license: "OFL-1.1",
    copyright: "Copyright 2022 The Noto Project Authors (https://github.com/notofonts/devanagari)",
    files: [
      {
        script: "devanagari",
        weight: 400,
        sha256: "e64b3b73131abb4074d4b22453bffe54fe8973fa0ea98a32504570df647b2a0a",
        bytes: 50952,
      },
      {
        script: "devanagari",
        weight: 700,
        sha256: "1d1f58114673c792115c90ac21bf211da08fe7f76154c1582ce2d0c7d5b38407",
        bytes: 55408,
      },
      {
        script: "latin",
        weight: 400,
        sha256: "78c02fc7054ec7a51ed4c016677b06c3431c2a675d85a511cab96c8579a1bc61",
        bytes: 11920,
      },
      {
        script: "latin",
        weight: 700,
        sha256: "5deb7e04a8e9e77f0d76239a933b4c9648835d49e0ee92a42ca06945d7aebae4",
        bytes: 12628,
      },
    ],
  },
  {
    key: "jetbrains-mono",
    name: "JetBrains Mono",
    kind: "mono",
    scripts: ["latin"],
    package: "@fontsource/jetbrains-mono",
    version: "5.3.0",
    integrity:
      "sha512-fqDfB5I9f1p1TV486aUgB9t8zP84P0O1FtQR5Ol9vjwPy+S+EIGlVYm1cvj2W5shcZMTg2nZFdVMoH5wFu8a1A==",
    license: "OFL-1.1",
    copyright:
      "Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono)",
    files: [
      {
        script: "latin",
        weight: 400,
        sha256: "14425ba9c695763c1547f48a206b7aa60350a33ae23de09f0407877f3fcd89eb",
        bytes: 21168,
      },
      {
        script: "latin",
        weight: 700,
        sha256: "d0d4e818808f2a0ba39b2b09d1989366f63494e295f003c7ef436697378507e8",
        bytes: 21908,
      },
    ],
  },
];
