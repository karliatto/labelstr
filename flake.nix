{
  description = "Route96 - Decentralized blob storage server with Nostr integration";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    crane.url = "github:ipetkov/crane";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, rust-overlay, crane, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        overlays = [ (import rust-overlay) ];
        pkgs = import nixpkgs { inherit system overlays; };

        # Rust edition 2024 requires Rust >= 1.85
        rustToolchain = pkgs.rust-bin.stable.latest.default.override {
          extensions = [ "rust-src" "clippy" "rustfmt" ];
        };

        craneLib = (crane.mkLib pkgs).overrideToolchain rustToolchain;

        # Native build inputs (tools needed at build time)
        nativeBuildInputs = with pkgs; [
          pkg-config
          clang
          rustToolchain
        ];

        # Runtime library dependencies
        buildInputs = with pkgs; [
          openssl
          ffmpeg_7      # Required by media-compression / labels features
          libmysqlclient
        ];

        # Environment variables for bindgen (ffmpeg-rs-raw uses bindgen)
        envVars = {
          LIBCLANG_PATH = "${pkgs.libclang.lib}/lib";
          OPENSSL_NO_VENDOR = "1";
          # Point bindgen at the clang headers
          BINDGEN_EXTRA_CLANG_ARGS =
            "-I${pkgs.llvmPackages.libclang.lib}/lib/clang/${pkgs.llvmPackages.libclang.version}/include";
        };

        # Common source filter — keep SQL migrations alongside Rust source
        src = pkgs.lib.cleanSourceWith {
          src = craneLib.cleanCargoSource ./.;
          filter = path: type:
            (pkgs.lib.hasSuffix ".sql" path) ||
            (craneLib.filterCargoSources path type);
        };

        commonArgs = {
          inherit src nativeBuildInputs buildInputs;

          # Match the features used in the Dockerfile
          cargoExtraArgs = "--features blossom,nip96,react-ui,r96util,media-compression,labels";
        } // envVars;

        # Build only dependencies first (enables better caching)
        cargoArtifacts = craneLib.buildDepsOnly commonArgs;

        route96 = craneLib.buildPackage (commonArgs // {
          inherit cargoArtifacts;

          # Build the UI before packaging if Node.js tools are available
          preBuild = ''
            if [ -d ui_src ] && command -v yarn &>/dev/null; then
              echo "Building React UI..."
              cd ui_src
              yarn install --immutable
              yarn build
              cd ..
            fi
          '';
        });
      in
      {
        packages = {
          default = route96;
          inherit route96;
        };

        checks = {
          # Run clippy on the workspace
          clippy = craneLib.cargoClippy (commonArgs // {
            inherit cargoArtifacts;
            cargoClippyExtraArgs = "-- --deny warnings";
          });

          # Run tests
          test = craneLib.cargoTest (commonArgs // {
            inherit cargoArtifacts;
          });
        };

        devShells.default = pkgs.mkShell ({
          inherit nativeBuildInputs;

          buildInputs = buildInputs ++ (with pkgs; [
            # Rust tooling
            rust-analyzer
            cargo-watch
            cargo-edit

            # Database
            sqlx-cli
            mariadb

            # Node.js for the React UI
            nodejs_22
            nodePackages.yarn

            # Useful dev tools
            jq
          ]);

          shellHook = ''
            echo "Route96 development environment"
            echo ""
            echo "  cargo build                          - build the server (default features)"
            echo "  cargo build --no-default-features    - build without FFmpeg/AI deps"
            echo "  cd ui_src && yarn dev                - start the Vite dev server"
            echo "  sqlx migrate run                     - apply database migrations"
          '';
        } // envVars);
      }
    );
}
