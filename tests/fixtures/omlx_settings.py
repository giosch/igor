"""Validate Igor's real launch arguments and model settings with installed oMLX."""

from unittest.mock import patch

from omlx import cli
from omlx.model_settings import ModelSettingsManager

# Stop at dispatch so the fixture can use the real parser without a GPU or weights.
with patch.object(cli, "serve_command") as serve:
    cli.main()
    serve.assert_called_once()
    args = serve.call_args.args[0]
    assert args.host == "127.0.0.1"
    settings = ModelSettingsManager(args.base_path)
    assert settings.get_pinned_model_ids() == ["test-weight"]
    model = settings.get_settings("test-weight")
    assert model.mtp_enabled and model.max_context_window == 32768 and model.max_tokens == 8192
