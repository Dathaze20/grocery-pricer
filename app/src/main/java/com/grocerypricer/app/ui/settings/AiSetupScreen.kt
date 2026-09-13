package com.grocerypricer.app.ui.settings

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.grocerypricer.app.di.AppContainer
import com.grocerypricer.app.ui.components.InfoBanner
import com.grocerypricer.app.ui.components.SectionCard
import com.grocerypricer.app.ui.components.WarningBanner
import com.grocerypricer.core.ai.AiConfig
import com.grocerypricer.core.ai.AiResult
import kotlinx.coroutines.launch

/**
 * Where the shopkeeper's API key is entered, once.
 *
 * The key is theirs and it is billable, which is why this screen exists at all rather than a key
 * being shipped in the APK. It is stored encrypted by the Android Keystore and never appears
 * again: once saved, this screen shows a mask, not the key.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AiSetupScreen(container: AppContainer, onBack: () -> Unit) {
    val scope = rememberCoroutineScope()
    val keyStore = remember { container.secureKeyStore }

    var keyInput by remember { mutableStateOf("") }
    var savedMask by remember { mutableStateOf(keyStore.maskedApiKey()) }
    var model by remember { mutableStateOf(AiConfig.DEFAULT_MODEL) }
    var status by remember { mutableStateOf<String?>(null) }
    var testing by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) {
        model = container.settingsRepository.current().aiModel
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("AI setup") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.Default.ArrowBack, contentDescription = "Back")
                    }
                },
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
        ) {
            InfoBanner(
                "Grocery Pricer reads your receipt photos using an AI provider you pay for " +
                    "directly. The key stays on this phone, encrypted. It is never sent anywhere " +
                    "except to the provider you choose.",
            )

            SectionCard(title = "API key", modifier = Modifier.padding(top = 16.dp)) {
                if (savedMask != null) {
                    Text(
                        savedMask!!,
                        style = MaterialTheme.typography.titleMedium,
                        modifier = Modifier.padding(bottom = 8.dp),
                    )
                    Text(
                        "A key is saved on this phone.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }

                OutlinedTextField(
                    value = keyInput,
                    onValueChange = { keyInput = it; status = null },
                    modifier = Modifier.fillMaxWidth().padding(top = 12.dp),
                    label = { Text(if (savedMask == null) "Paste your API key" else "Replace the key") },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(
                        keyboardType = KeyboardType.Password,
                        imeAction = ImeAction.Done,
                    ),
                )

                Button(
                    onClick = {
                        val ok = keyStore.saveApiKey(keyInput)
                        keyInput = ""
                        savedMask = keyStore.maskedApiKey()
                        status = if (ok) "Key saved." else "That key could not be saved."
                    },
                    enabled = keyInput.isNotBlank(),
                    modifier = Modifier.fillMaxWidth().padding(top = 12.dp),
                ) { Text("SAVE KEY") }

                if (savedMask != null) {
                    OutlinedButton(
                        onClick = {
                            keyStore.clear()
                            savedMask = null
                            status = "Key removed from this phone."
                        },
                        modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                    ) { Text("REMOVE KEY") }
                }
            }

            SectionCard(title = "Model", modifier = Modifier.padding(top = 16.dp)) {
                Text(
                    "Which model reads your receipts. Left as free text so a newer one can be " +
                        "used without waiting for an app update.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                OutlinedTextField(
                    value = model,
                    onValueChange = { model = it },
                    modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                    label = { Text("Model") },
                    singleLine = true,
                )
                Text(
                    "Suggested: " + AiConfig.SUGGESTED_MODELS.joinToString(", "),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = 8.dp),
                )
                Button(
                    onClick = {
                        scope.launch {
                            container.settingsRepository.update { it.copy(aiModel = model.trim()) }
                            status = "Model saved."
                        }
                    },
                    modifier = Modifier.fillMaxWidth().padding(top = 12.dp),
                ) { Text("SAVE MODEL") }
            }

            OutlinedButton(
                onClick = {
                    testing = true
                    status = null
                    scope.launch {
                        val provider = container.aiProviderOrNull()
                        status = if (provider == null) {
                            "Save a key first."
                        } else {
                            when (val result = provider.testConnection()) {
                                is AiResult.Success -> "Connected. Grocery Pricer can read receipts."
                                is AiResult.Failure -> result.error.userMessage()
                            }
                        }
                        testing = false
                    }
                },
                enabled = !testing,
                modifier = Modifier.fillMaxWidth().padding(top = 16.dp),
            ) { Text(if (testing) "TESTING..." else "TEST CONNECTION") }

            status?.let {
                if (it.startsWith("Connected") || it.endsWith("saved.") || it.contains("removed")) {
                    InfoBanner(it, modifier = Modifier.padding(top = 16.dp))
                } else {
                    WarningBanner(it, modifier = Modifier.padding(top = 16.dp))
                }
            }
        }
    }
}
