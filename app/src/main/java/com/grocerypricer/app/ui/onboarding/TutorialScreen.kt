package com.grocerypricer.app.ui.onboarding

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.PhotoCamera
import androidx.compose.material.icons.filled.PriceCheck
import androidx.compose.material.icons.filled.QrCodeScanner
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.grocerypricer.app.ui.components.BigActionButton
import kotlinx.coroutines.launch

private data class TutorialPage(
    val icon: ImageVector,
    val title: String,
    val body: String,
)

private val PAGES = listOf(
    TutorialPage(
        Icons.Default.PhotoCamera,
        "Scan Your Wholesale Receipt",
        "Take photos or import screenshots. Add as many as the receipt needs - Grocery Pricer reads them as one order.",
    ),
    TutorialPage(
        Icons.Default.PriceCheck,
        "Review Your Costs",
        "Grocery Pricer calculates real unit cost after case discounts. Anything it is unsure about is flagged for you to check before it is saved.",
    ),
    TutorialPage(
        Icons.Default.QrCodeScanner,
        "Scan Products and Price Them",
        "Walk the store, scan a barcode, and approve your store price. Cost, suggested price and margin are on one screen.",
    ),
)

/** Shown once on first launch. Skippable, and resettable from Settings. */
@Composable
fun TutorialScreen(onFinished: () -> Unit) {
    val pagerState = rememberPagerState(pageCount = { PAGES.size })
    val scope = rememberCoroutineScope()

    Column(Modifier.fillMaxSize().padding(24.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            TextButton(onClick = onFinished) { Text("Skip") }
        }

        HorizontalPager(state = pagerState, modifier = Modifier.weight(1f)) { page ->
            val item = PAGES[page]
            Column(
                modifier = Modifier.fillMaxSize(),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
            ) {
                Icon(
                    item.icon,
                    contentDescription = null,
                    modifier = Modifier.size(96.dp),
                    tint = MaterialTheme.colorScheme.primary,
                )
                Spacer(Modifier.height(32.dp))
                Text(
                    "${page + 1}. ${item.title}",
                    style = MaterialTheme.typography.headlineMedium,
                    textAlign = TextAlign.Center,
                )
                Spacer(Modifier.height(16.dp))
                Text(
                    item.body,
                    style = MaterialTheme.typography.bodyLarge,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.Center,
                )
            }
        }

        Row(
            Modifier.fillMaxWidth().padding(vertical = 16.dp),
            horizontalArrangement = Arrangement.Center,
        ) {
            PAGES.indices.forEach { index ->
                Box(
                    Modifier
                        .padding(horizontal = 4.dp)
                        .size(if (index == pagerState.currentPage) 12.dp else 8.dp),
                ) {
                    Surface(
                        shape = CircleShape,
                        color = if (index == pagerState.currentPage) {
                            MaterialTheme.colorScheme.primary
                        } else {
                            MaterialTheme.colorScheme.surfaceVariant
                        },
                        modifier = Modifier.fillMaxSize(),
                    ) {}
                }
            }
        }

        val isLast = pagerState.currentPage == PAGES.lastIndex
        BigActionButton(
            text = if (isLast) "START" else "NEXT",
            onClick = {
                if (isLast) {
                    onFinished()
                } else {
                    scope.launch { pagerState.animateScrollToPage(pagerState.currentPage + 1) }
                }
            },
        )
    }
}
