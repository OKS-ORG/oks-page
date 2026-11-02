"use client";
// oks-ui parts for the pages. oks-ui 1.5.0 has no "use client" mark, so a server page cannot use its components
// directly ("useState is not a function"). This file is the client boundary until oks-ui adds the mark (work list).
export { Card, CardBody } from "oks-ui";
