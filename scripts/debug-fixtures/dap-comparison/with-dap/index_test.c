#include "index.h"

#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static size_t occupied_slot(const ReceiptIndex *index) {
    for (size_t i = 0; i < INDEX_CAPACITY; ++i) {
        if (index->slots[i].state == 1) return i;
    }
    abort();
}

int main(void) {
    ReceiptIndex index;
    char first_at_slot[INDEX_CAPACITY][KEY_LIMIT] = {{0}};
    char older[KEY_LIMIT] = {0};
    char newer[KEY_LIMIT] = {0};

    /* Discover a collision using the index itself, without duplicating its hash. */
    for (unsigned n = 0; n <= INDEX_CAPACITY; ++n) {
        char key[KEY_LIMIT];
        snprintf(key, sizeof(key), "receipt-%u", n);
        index_init(&index);
        assert(index_record(&index, key, 0) == 1);
        size_t slot = occupied_slot(&index);
        if (first_at_slot[slot][0] != '\0') {
            strcpy(older, first_at_slot[slot]);
            strcpy(newer, key);
            break;
        }
        strcpy(first_at_slot[slot], key);
    }
    assert(older[0] != '\0' && newer[0] != '\0');

    index_init(&index);
    assert(index_record(&index, older, 0) == 1);
    assert(index_record(&index, newer, 1) == 1);
    assert(index_contains(&index, newer));
    index_retire_before(&index, 1);
    assert(!index_contains(&index, older));
    assert(index_contains(&index, newer)); /* Must probe past older's tombstone. */
    assert(index.live == 1 && index.retired == 1);
    puts("receipt tombstone lookup verified");
    return 0;
}
