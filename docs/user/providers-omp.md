# Oh My Pi

Oh My Pi (OMP) is an agent runtime that supports multiple model providers through one CLI. T3
Code includes OMP as a built-in provider, but it is off by default.

## Install OMP

Install OMP on the machine that runs the Tx Code server:

```bash
curl -fsSL https://omp.sh/install | sh
```

You can also install it with Homebrew:

```bash
brew install can1357/tap/omp
```

Run the setup flow and choose a default model:

```bash
omp setup
```

## Enable OMP in Tx Code

Open **Settings** and enable the Oh My Pi provider. The default binary path is `omp`. Set a
different binary path when OMP is installed outside your `PATH`. Use **Launch arguments** only
when your OMP setup needs extra command-line options.

Run `omp models` to check that OMP can discover models before starting a Tx Code thread.

Tx Code uses each model's OMP provider ID in the model picker. This identifies models that have
the same display name, such as models available through both Moonshot and OpenRouter.

Periodic health checks do not load OMP extensions. If an extension registers a model, add its full
OMP selector under **Custom models**. The normal OMP session loads the extension and validates the
selector when the thread starts.

## Permission behavior

Tx Code maps its permission modes to OMP approval modes:

- **Supervised** and **Auto** use OMP's `always-ask` mode.
- **Auto-accept edits** uses OMP's `write` mode.
- **Full access** uses OMP's `yolo` mode.

Tx Code controls this mapping for every OMP session. Approval flags in **Launch arguments** cannot
override the selected Tx Code permission mode.

OMP 17.4.0 can show a second approval form for a supervised shell command or destructive edit. OMP
currently applies its ACP client gate and its native approval gate to those calls.

OMP does not yet expose the provider-history controls that Tx Code needs for checkpoint rollback or
the Tx Code Plan mode lifecycle. Tx Code hides Plan mode for OMP and reports checkpoint rollback as
unsupported. Follow-up messages wait for the active OMP turn to finish, then start a new turn.

## OpenRouter upstreams

OpenRouter can serve one model from several upstream providers, such as DeepInfra, Cerebras, or
Amazon Bedrock. Those endpoints differ in price, quantization, throughput, and context limit. To
choose one, list the upstreams you use under **Settings → Providers → Oh My Pi → OpenRouter
upstreams**, comma-separated, for example `deepinfra, cerebras`.

OpenRouter models then show an **Upstream** control beside **Thinking** in the composer. **Auto**
keeps OpenRouter's own routing; picking a provider pins that thread's requests for that model to it,
including after the thread is resumed and for delegated work that runs the same model. A change
applies from the next message, and the selection is stored with the thread, so another device sees
the same pin.

A pin is a hard restriction: if the chosen upstream does not serve the model, OpenRouter rejects the
request instead of falling back. Pick **Auto** to restore OpenRouter's routing. Tx Code applies the
pin through a small OMP extension it generates itself; your OMP configuration and `models.yml` are
not modified.
