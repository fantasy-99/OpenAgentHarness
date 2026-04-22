# Models

Add one or more platform model YAML files here before deploying.

The bundled starter runtime expects a platform model named `openai-default`, so a minimal file can look like:

```yaml
openai-default:
  provider: openai
  key: ${env.OPENAI_API_KEY}
  name: gpt-5
```

You can also define OpenAI-compatible or other supported providers here.
