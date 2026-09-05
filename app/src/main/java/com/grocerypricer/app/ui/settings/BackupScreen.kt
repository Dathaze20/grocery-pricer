package com.grocerypricer.app.ui.settings

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Backup
import androidx.compose.material.icons.filled.Restore
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.grocerypricer.app.backup.RestoreResult
import com.grocerypricer.app.data.model.AppSettings
import com.grocerypricer.app.di.AppContainer
import com.grocerypricer.app.ui.components.BigActionButton
import com.grocerypricer.app.ui.components.ConfirmDialog
import com.grocerypricer.app.ui.components.InfoBanner
import com.grocerypricer.app.ui.components.SectionCard
import com.grocerypricer.app.ui.components.WarningBanner
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

@Composable
fun BackupScreen(
    container: AppContainer,
    settings: AppSettings,
    onBack: () -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    var busy by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    var pendingRestoreJson by remember { mutableStateOf<String?>(null) }

    val createBackup = rememberLauncherForActivityResult(
        ActivityResultContracts.CreateDocument("application/json"),
    ) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        scope.launch {
            busy = true
            errorMessage = null
            val result = runCatching {
                val json = container.backupManager.createBackup(settings.includeImagesInBackup)
                withContext(Dispatchers.IO) {
                    context.contentResolver.openOutputStream(uri)?.use { it.write(json.toByteArray()) }
                }
                json.length
            }
            busy = false
            result.fold(
                onSuccess = { size -> message = "Backup written (${size / 1024} KB)." },
                onFailure = { errorMessage = "The backup could not be written: ${it.message}" },
            )
        }
    }

    val openBackup = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenDocument(),
    ) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        scope.launch {
            busy = true
            errorMessage = null
            val read = runCatching {
                withContext(Dispatchers.IO) {
                    context.contentResolver.openInputStream(uri)?.bufferedReader()?.use { it.readText() }
                }
            }
            busy = false
            read.fold(
                onSuccess = { json ->
                    if (json.isNullOrBlank()) {
                        errorMessage = "That file is empty."
                    } else {
                        pendingRestoreJson = json
                    }
                },
                onFailure = { errorMessage = "That file could not be opened: ${it.message}" },
            )
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Backup and restore") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
            )
        },
    ) { padding ->
        Column(
            Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(16.dp)
                .verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            message?.let { InfoBanner(it) }
            errorMessage?.let { WarningBanner(it) }
            if (busy) CircularProgressIndicator()

            SectionCard("Backup") {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text(
                        "A backup holds your products, orders, price history, pricing rules and settings " +
                            "as one file you choose the location of. " +
                            if (settings.includeImagesInBackup) {
                                "Receipt photos are included, so the file will be large."
                            } else {
                                "Receipt photos are not included; turn that on in Settings if you want them."
                            },
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    BigActionButton(
                        "EXPORT BACKUP",
                        icon = Icons.Default.Backup,
                        enabled = !busy,
                        onClick = { createBackup.launch(container.backupManager.suggestedFileName()) },
                    )
                }
            }

            SectionCard("Restore") {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text(
                        "Restoring replaces everything currently in the app with the contents of the backup file.",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    BigActionButton(
                        "RESTORE BACKUP",
                        icon = Icons.Default.Restore,
                        enabled = !busy,
                        onClick = { openBackup.launch(arrayOf("application/json", "text/plain", "*/*")) },
                    )
                }
            }

            Spacer(Modifier.height(32.dp))
        }
    }

    pendingRestoreJson?.let { json ->
        ConfirmDialog(
            title = "Replace everything?",
            message = "Restoring will delete the products, orders and price history currently on this device " +
                "and replace them with the backup. This cannot be undone.",
            confirmLabel = "Restore and replace",
            destructive = true,
            onConfirm = {
                scope.launch {
                    busy = true
                    val result = container.backupManager.restore(json)
                    busy = false
                    when (result) {
                        is RestoreResult.Success -> {
                            message = "Restored ${result.products} product(s), ${result.orders} order(s) and " +
                                "${result.priceHistory} price history entries."
                            errorMessage = null
                        }
                        is RestoreResult.Failure -> {
                            errorMessage = result.message
                            message = null
                        }
                    }
                }
            },
            onDismiss = { pendingRestoreJson = null },
        )
    }
}
