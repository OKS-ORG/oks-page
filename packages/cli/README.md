# @oks-page/cli

The `oks` command of oks-page. It is installed in every site made with `create-oks-page`. Run `oks --help` for the full list. In short:

```
oks check [folder]        Check a plugin before you publish it.
oks pack [folder]         Check a plugin, then write it as one .oksplugin file to upload in Tools > Plugins.
oks export [folder]       Check a site, then write it as plain files (a static export).
oks publish [folder] --zip file | --folder dir
                          Send an exported site to a zip file or a folder, sending only what changed.
oks media migrate --to s3|local
                          Copy every uploaded file between the uploads folder and an S3 bucket.
oks migrate               Make or update the database tables.
oks user reset <email>    Give an account a new one-time password (needs the secret key in .env).
```

More: <https://github.com/OKS-ORG/oks-page#readme>.

Licence: MIT.
