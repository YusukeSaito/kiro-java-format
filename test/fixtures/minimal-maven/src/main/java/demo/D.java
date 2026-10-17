package demo;

import org.apache.commons.lang3.StringUtils;
import java.util.Arrays;
import java.util.stream.Collectors;
import java.util.List;
import java.util.regex.Pattern;

public class D {
  public List<String> capitalizeAll(String... words){
      return Arrays.stream(words)
                .map(StringUtils::capitalize)
        .collect(Collectors.toList());
            }

    public String abbreviate(String text) { return StringUtils.abbreviate(text, 10); }
}
